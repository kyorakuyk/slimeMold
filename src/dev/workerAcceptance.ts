import type { WorkerAcceptance, WorkerAcceptanceResult } from './codexWorkerExecutor';
import type { DevSession } from './session';
import { evaluateDevAcceptance, type AcceptanceRule } from './evaluator';
import { collectChangedProtectedPaths, isPathAllowed } from './policy';
import type { EvidenceRecord } from './evidence';

export interface DevWorkerAcceptanceOptions {
  /** 默认使用项目现有测试入口；命令仍由 DevCapabilityService 的白名单校验。 */
  testCommand?: string[];
}

type DevWorkerAcceptanceHost = Pick<
  DevSession,
  'policy' | 'service' | 'collector' | 'nextAcceptanceId' | 'recordAcceptance'
>;

function commandLabel(command: readonly string[]): string {
  return command.join(' ').trim();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  const testCommand = [...(options.testCommand ?? ['npm', 'run', 'test'])];
  if (testCommand.length === 0 || testCommand.some((part) => !part.trim())) {
    throw new Error('Worker acceptance 的 testCommand 不能为空');
  }

  return {
    async evaluate({ lease }): Promise<WorkerAcceptanceResult> {
      const cwd = lease.assignment.path;
      const orchestrationId = lease.orchestrationId ?? lease.runId;
      const stageId = lease.task.id;
      const context = { cwd };
      const testLabel = commandLabel(testCommand);

      try {
        const test = await host.service.testRun(testCommand, context);
        const diff = await host.service.gitDiff(lease.assignment.baseRevision, context);
        const changedFiles = await host.service.gitChangedFiles(context);
        const changedProtectedPaths = collectChangedProtectedPaths(host.policy, changedFiles);
        const changedDisallowedPaths = changedFiles.filter((file) => !isPathAllowed(host.policy, file));
        const hasDiff = diff.exitCode === 0 && changedFiles.length > 0;
        const pathPolicyPassed = changedProtectedPaths.length === 0 && changedDisallowedPaths.length === 0;

        const freshEvidence: EvidenceRecord[] = [];
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'test',
          status: test.exitCode === 0 ? 'passed' : 'failed',
          command: testLabel,
          exitCode: test.exitCode,
          summary: `宿主测试退出码 ${test.exitCode}`,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'diff',
          status: hasDiff ? 'passed' : 'failed',
          summary: hasDiff
            ? `检测到 ${changedFiles.length} 个实际变更文件`
            : '未检测到可验收的实际变更',
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));
        freshEvidence.push(await host.collector.addAsync({
          orchestrationId,
          stageId,
          kind: 'path-policy',
          status: pathPolicyPassed ? 'passed' : 'failed',
          summary: pathPolicyPassed
            ? `路径策略通过（${changedFiles.length} 个变更文件）`
            : `路径策略拒绝（受保护 ${changedProtectedPaths.length} 个，越界 ${changedDisallowedPaths.length} 个）`,
          worktreePath: cwd,
          baseRevision: lease.assignment.baseRevision,
        }));

        // addAsync 已等待单条落盘；flush 仍是验收前的统一持久化屏障，防止其它在途证据混入未落盘状态。
        await host.collector.flushAndByScope({ orchestrationId, stageId, worktreePath: cwd });
        const rules: AcceptanceRule[] = [
          { id: 'tests', kind: 'test', command: testLabel },
          { id: 'diff', kind: 'diff' },
          { id: 'path-policy', kind: 'path-policy' },
        ];
        const verdict = evaluateDevAcceptance(rules, freshEvidence, changedProtectedPaths);
        const acceptanceId = host.nextAcceptanceId();
        host.recordAcceptance({
          acceptanceId,
          orchestrationId,
          stageId,
          worktreePath: cwd,
          passed: verdict.passed,
          failedChecks: verdict.failedChecks,
          at: new Date().toISOString(),
        });
        return {
          passed: verdict.passed,
          evidenceIds: freshEvidence.map((record) => record.id),
          acceptanceId,
          failureReason: verdict.passed ? undefined : `宿主验收失败：${verdict.failedChecks.join(', ')}`,
        };
      } catch (cause) {
        return {
          passed: false,
          failureReason: `宿主验收无法完成：${errorMessage(cause)}`,
        };
      }
    },
  };
}
