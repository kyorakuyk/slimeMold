import type {
  WorkerExecutionResult,
  WorkerExecutor,
  WorkerTaskLease,
} from '../domain/workerQueue';
import { codexWorkerExec } from '../agents/providers/codex';

export interface CodexWorkerResponse {
  text: string;
  usage?: unknown;
}

export interface CodexWorkerInvoker {
  execute(input: {
    prompt: string;
    model?: string;
    cwd: string;
  }): Promise<CodexWorkerResponse>;
}

export interface WorkerAcceptanceResult {
  passed: boolean;
  evidenceIds?: readonly string[];
  failureReason?: string;
}

export interface WorkerAcceptance {
  evaluate(input: {
    lease: WorkerTaskLease;
    response: CodexWorkerResponse;
  }): Promise<WorkerAcceptanceResult> | WorkerAcceptanceResult;
}

export interface CodexWorkerExecutorOptions {
  invoker: CodexWorkerInvoker;
  acceptance: WorkerAcceptance;
  model?: string;
}

/** Wire the queue invoker to the Tauri Codex Worker command. */
export function createCodexWorkerInvoker(): CodexWorkerInvoker {
  return {
    async execute({ prompt, model, cwd }): Promise<CodexWorkerResponse> {
      const result = await codexWorkerExec(prompt, model, cwd);
      return { text: result.text, usage: result.usage };
    },
  };
}

/** Build the only prompt a code-writing Worker receives from a queue lease. */
export function buildCodexWorkerPrompt(lease: WorkerTaskLease): string {
  const { task, assignment, attempt } = lease;
  return [
    '你是 SlimeMold 的实现 Worker。只在当前已分配的 worktree 内完成一个任务。',
    `Worktree: ${assignment.path}`,
    `Attempt: ${attempt}`,
    '',
    `任务标题：${task.title}`,
    `任务描述：${task.description}`,
    `允许涉及的范围：${task.scope.length > 0 ? task.scope.join(', ') : '(未声明)'}`,
    `依赖任务：${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '(无)'}`,
    '验收标准：',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '约束：',
    '- 只能修改当前 worktree，不要读取或写入其它项目、主仓库或凭据。',
    '- 不要 push、merge、release 或删除远程资源。',
    '- 不要把 API key、token、密码或其它 secret 写入文件、输出或摘要。',
    '- 完成后只报告做了什么；是否成功由宿主运行确定性验收决定。',
  ].join('\n');
}

export function createCodexWorkerExecutor(options: CodexWorkerExecutorOptions): WorkerExecutor {
  return {
    async execute(lease): Promise<WorkerExecutionResult> {
      const response = await options.invoker.execute({
        prompt: buildCodexWorkerPrompt(lease),
        model: options.model?.trim() || undefined,
        cwd: lease.assignment.path,
      });
      if (!response.text.trim()) {
        return { status: 'failed', error: 'Codex Worker 没有返回最终消息' };
      }

      const verdict = await options.acceptance.evaluate({ lease, response });
      if (!verdict.passed) {
        return {
          status: 'failed',
          error: verdict.failureReason?.trim() || '宿主验收失败',
        };
      }
      const evidenceIds = [...new Set((verdict.evidenceIds ?? []).map((id) => id.trim()).filter(Boolean))];
      if (evidenceIds.length === 0) {
        return { status: 'failed', error: '宿主验收通过但没有 Evidence ID' };
      }
      return { status: 'succeeded', evidenceIds };
    },
  };
}
