import type { WorkerAcceptance, WorkerAcceptanceResult } from './codexWorkerExecutor';
import type { DevSession } from './session';
import { evaluateDevAcceptance, type AcceptanceRule } from './evaluator';
import { collectChangedProtectedPaths, isPathAllowed } from './policy';
import type { EvidenceRecord } from './evidence';
import { assertTaskExecutionLineage } from '../domain/execution';
import { resolveWorkerAcceptanceStageId } from '../domain/workerQueue';

export interface DevWorkerAcceptanceOptions {
  /** 默认使用项目现有编译入口；命令仍由 DevCapabilityService 的白名单校验。 */
  compileCommand?: string[];
  /** 默认使用项目现有测试入口；命令仍由 DevCapabilityService 的白名单校验。 */
  testCommand?: string[];
  /** Use approved Task scope instead of the SlimeMold self-development policy for disposable targets. */
  taskScopePolicy?: boolean;
}

type DevWorkerAcceptanceHost = Pick<
  DevSession,
  'policy' | 'service' | 'collector' | 'nextAcceptanceId' | 'recordAcceptance' | 'persistAcceptance'
>;

function commandLabel(command: readonly string[]): string {
  return command.join(' ').trim();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Worker acceptance 已取消');
  error.name = 'AbortError';
  throw error;
}

function createTaskScopePolicy(
  hostPolicy: DevWorkerAcceptanceHost['policy'],
  scope: readonly string[],
): DevWorkerAcceptanceHost['policy'] {
  const explicitPaths = scope.filter((item) => /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.*-]+$/.test(item));
  const serverPaths = scope.some((item) => /http\s*server/i.test(item))
    ? ['package.json', 'server.*']
    : [];
  return {
    ...hostPolicy,
    allowedPaths: [...new Set([...explicitPaths, ...serverPaths])],
    protectedPaths: ['.slimemold/**', 'artifacts/**'],
  };
}

function usesScaffoldValidation(scope: readonly string[]): boolean {
  return scope.some((item) => item === 'public/index.html' || /^src\/main\.[*A-Za-z0-9_-]+$/.test(item))
    && scope.some((item) => /http\s*server/i.test(item));
}

function isCodeFile(file: string): boolean {
  return /\.(?:[cm]?js|jsx|tsx?|mjs|cjs)$/i.test(file);
}

function resolveTaskValidationCommands(
  defaults: { compile: string[]; test: string[]; custom: boolean },
  scaffold: boolean,
  changedFiles: readonly string[],
): { compile: string[]; test: string[] } {
  if (defaults.custom || scaffold) {
    return scaffold
      ? { compile: ['node', '--check', 'src/main.js'], test: ['node', '--check', 'server.mjs'] }
      : { compile: defaults.compile, test: defaults.test };
  }
  const codeFiles = changedFiles.filter(isCodeFile);
  const onlyCodeChanges = codeFiles.length > 0
    && changedFiles.every((file) => file === '.gitignore' || codeFiles.includes(file));
  if (!onlyCodeChanges) return { compile: defaults.compile, test: defaults.test };
  const typeScriptFiles = codeFiles.filter((file) => /\.tsx?$/i.test(file));
  if (typeScriptFiles.length > 0) {
    const command = ['tsc', '--noEmit', '--target', 'es2020', ...typeScriptFiles];
    return { compile: command, test: [...command] };
  }
  return {
    compile: ['node', '--check', codeFiles[0]],
    test: ['node', '--check', codeFiles[1] ?? codeFiles[0]],
  };
}

/**
 * 构造 Worker 的宿主验收器。
 *
 * 验收只使用宿主真实执行结果：Worker 的最终文本不会改变结论；测试、diff 和路径策略
 * 都必须在对应 worktree 中重新采集，并且 Evidence 落盘完成后才能交给 evaluator。
 */
export function createDevWorkerAcceptance(
  host: DevWorkerAcceptanceHost,
  options: DevWorkerAcceptanceOptions = {},
): WorkerAcceptance {
  const compileCommand = [...(options.compileCommand ?? ['npm', 'run', 'build'])];
  const testCommand = [...(options.testCommand ?? ['npm', 'run', 'test'])];
  if (compileCommand.length === 0 || compileCommand.some((part) => !part.trim())) {
    throw new Error('Worker acceptance 的 compileCommand 不能为空');
  }
  if (testCommand.length === 0 || testCommand.some((part) => !part.trim())) {
    throw new Error('Worker acceptance 的 testCommand 不能为空');
  }

  return {
    async evaluate({ lease, signal }): Promise<WorkerAcceptanceResult> {
      throwIfAborted(signal);
      try {
        assertTaskExecutionLineage({
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          attempt: lease.attempt,
        });
      } catch (cause) {
        return { passed: false, evidenceIds: [], failureReason: `Worker lineage 无效：${errorMessage(cause)}` };
      }
      const cwd = lease.assignment.path;
      const orchestrationId = lease.orchestrationId ?? lease.runId;
      const stageId = resolveWorkerAcceptanceStageId(lease.task.id, lease.task.stageId);
      if (!stageId) {
        return {
          passed: false,
          evidenceIds: [],
          failureReason: 'Worker Acceptance stage 无效，拒绝验收',
        };
      }
      if (!host.collector.hasPersistence()) {
        return {
          passed: false,
          failureReason: '宿主 EvidenceStore 未配置持久化，拒绝验收',
        };
      }
      const context = { cwd };
      const policy = options.taskScopePolicy
        ? createTaskScopePolicy(host.policy, lease.task.scope)
        : host.policy;
      const scaffoldValidation = options.compileCommand === undefined
        && options.testCommand === undefined
        && usesScaffoldValidation(lease.task.scope);

      try {
        // Never execute a Worker-controlled build/test oracle before checking the files it changed.
      // In particular, package scripts, test configuration, and test sources must be rejected
      // before npm/vitest can interpret them.
      const preflightChangedFiles = await host.service.gitChangedFiles(context, lease.assignment.baseRevision);
      throwIfAborted(signal);
      const preflightProtectedPaths = collectChangedProtectedPaths(policy, preflightChangedFiles);
      const preflightDisallowedPaths = preflightChangedFiles.filter((file) => !isPathAllowed(policy, file));
      if (preflightProtectedPaths.length > 0 || preflightDisallowedPaths.length > 0) {
        const failureReason = `宿主验收在执行前拒绝路径策略：受保护 ${preflightProtectedPaths.length} 个，越界 ${preflightDisallowedPaths.length} 个`;
        const preflightEvidence = await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'path-policy',
          status: 'failed',
          summary: failureReason,
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        });
        throwIfAborted(signal);
        const persistedEvidence = await host.collector.flushAndByScope({
          orchestrationId,
          stageId,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
        });
        throwIfAborted(signal);
        if (!persistedEvidence.some((record) => record.id === preflightEvidence.id)) {
          throw new Error('Worker acceptance 的 preflight path-policy Evidence 未完成持久化');
        }
        const acceptanceId = host.nextAcceptanceId();
        const acceptance = host.recordAcceptance({
          acceptanceId,
          orchestrationId,
          stageId,
          worktreePath: cwd,
          passed: false,
          failedChecks: ['path-policy'],
          at: new Date().toISOString(),
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
        });
        throwIfAborted(signal);
        await host.persistAcceptance(acceptance);
        throwIfAborted(signal);
        return {
          passed: false,
          evidenceIds: [preflightEvidence.id],
          acceptanceId,
          failureReason,
        };
      }

      const validationCommands = resolveTaskValidationCommands(
        {
          compile: compileCommand,
          test: testCommand,
          custom: options.compileCommand !== undefined || options.testCommand !== undefined,
        },
        scaffoldValidation,
        preflightChangedFiles,
      );
      const taskCompileCommand = validationCommands.compile;
      const taskTestCommand = validationCommands.test;
      const compileLabel = commandLabel(taskCompileCommand);
      const testLabel = commandLabel(taskTestCommand);

      const compile = await host.service.testRun(taskCompileCommand, context);
        throwIfAborted(signal);
        const test = await host.service.testRun(taskTestCommand, context);
        throwIfAborted(signal);
        const diff = await host.service.gitDiff(lease.assignment.baseRevision, context);
        throwIfAborted(signal);
        const changedFiles = await host.service.gitChangedFiles(context, lease.assignment.baseRevision);
        throwIfAborted(signal);
        const changedProtectedPaths = collectChangedProtectedPaths(policy, changedFiles);
        const changedDisallowedPaths = changedFiles.filter((file) => !isPathAllowed(policy, file));
        const hasDiff = diff.exitCode === 0 && changedFiles.length > 0;
        const pathPolicyPassed = changedProtectedPaths.length === 0 && changedDisallowedPaths.length === 0;

        const freshEvidence: EvidenceRecord[] = [];
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'test',
          status: compile.exitCode === 0 ? 'passed' : 'failed',
          command: compileLabel,
          exitCode: compile.exitCode,
          summary: `宿主编译退出码 ${compile.exitCode}`,
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        throwIfAborted(signal);
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'test',
          status: test.exitCode === 0 ? 'passed' : 'failed',
          command: testLabel,
          exitCode: test.exitCode,
          summary: `宿主测试退出码 ${test.exitCode}`,
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        throwIfAborted(signal);
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'diff',
          status: hasDiff ? 'passed' : 'failed',
          summary: hasDiff
            ? `检测到 ${changedFiles.length} 个实际变更文件`
            : '未检测到可验收的实际变更',
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        throwIfAborted(signal);
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'path-policy',
          status: pathPolicyPassed ? 'passed' : 'failed',
          summary: pathPolicyPassed
            ? `路径策略通过（${changedFiles.length} 个变更文件）`
            : `路径策略拒绝（受保护 ${changedProtectedPaths.length} 个，越界 ${changedDisallowedPaths.length} 个）`,
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        throwIfAborted(signal);

        // addAsync 已等待单条落盘；flush 仍是验收前的统一持久化屏障，防止其它在途证据混入未落盘状态。
        const persistedEvidence = await host.collector.flushAndByScope({
          orchestrationId,
          stageId,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
          worktreePath: cwd,
        });
        throwIfAborted(signal);
        if (!freshEvidence.every((record) => persistedEvidence.some((item) => item.id === record.id))) {
          throw new Error('Worker acceptance 的 Evidence lineage 未完成持久化');
        }
        const rules: AcceptanceRule[] = [
          { id: 'compile', kind: 'test', command: compileLabel },
          { id: 'tests', kind: 'test', command: testLabel },
          { id: 'diff', kind: 'diff' },
          { id: 'path-policy', kind: 'path-policy' },
        ];
        const verdict = evaluateDevAcceptance(rules, freshEvidence, changedProtectedPaths);
        throwIfAborted(signal);
        const acceptanceId = host.nextAcceptanceId();
        const acceptance = host.recordAcceptance({
          acceptanceId,
          orchestrationId,
          stageId,
          worktreePath: cwd,
          passed: verdict.passed,
          failedChecks: verdict.failedChecks,
          at: new Date().toISOString(),
          runId: lease.runId,
          taskId: lease.task.id,
          taskExecutionId: lease.taskExecutionId,
          attemptId: lease.attemptId,
        });
        throwIfAborted(signal);
        await host.persistAcceptance(acceptance);
        throwIfAborted(signal);
        return {
          passed: verdict.passed,
          evidenceIds: freshEvidence.map((record) => record.id),
          acceptanceId,
          failureReason: verdict.passed ? undefined : `宿主验收失败：${verdict.failedChecks.join(', ')}`,
        };
      } catch (cause) {
        if (signal?.aborted) throwIfAborted(signal);
        return {
          passed: false,
          failureReason: `宿主验收无法完成：${errorMessage(cause)}`,
        };
      }
    },
  };
}
