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
    signal?: AbortSignal;
  }): Promise<CodexWorkerResponse>;
}

export interface WorkerAcceptanceResult {
  passed: boolean;
  evidenceIds?: readonly string[];
  acceptanceId?: string;
  failureReason?: string;
}

export interface WorkerAcceptance {
  evaluate(input: {
    lease: WorkerTaskLease;
    response: CodexWorkerResponse;
    signal?: AbortSignal;
  }): Promise<WorkerAcceptanceResult> | WorkerAcceptanceResult;
}

export interface CodexWorkerExecutorOptions {
  invoker: CodexWorkerInvoker;
  acceptance: WorkerAcceptance;
  model?: string;
}

/** Wire the queue invoker to the Tauri Codex Worker command. */
export function createCodexWorkerInvoker(generation: number): CodexWorkerInvoker {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Codex Worker session generation is required');
  }
  return {
    async execute({ prompt, model, cwd, signal }): Promise<CodexWorkerResponse> {
      if (signal?.aborted) throw new Error('Codex Worker 请求已取消');
      const operationId = `worker-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      const onAbort = () => {
        void import('../agents/providers/codex').then(({ cancelCodexWorker }) => cancelCodexWorker(operationId));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await codexWorkerExec(prompt, model, cwd, operationId, generation);
        if (signal?.aborted) throw new Error('Codex Worker 请求已取消');
        return { text: result.text, usage: result.usage };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
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
    ...(lease.dependencyArtifacts && lease.dependencyArtifacts.length > 0
      ? [
        '已成功完成的依赖成果（只读参考；只能把需要的内容复制/整合到当前 Worktree，禁止修改这些路径）：',
        ...lease.dependencyArtifacts.map((artifact) => `- ${artifact.taskId} attempt=${artifact.attempt} path=${artifact.path}${artifact.branchRevision ? ` revision=${artifact.branchRevision}` : ''}`),
      ]
      : []),
    '验收标准：',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '约束：',
    '- 只能修改当前 worktree；只读依赖成果路径仅用于读取/复制参考，不得在原依赖 worktree 写入。',
    '- 不要 push、merge、release 或删除远程资源。',
    '- 不要把 API key、token、密码或其它 secret 写入文件、输出或摘要。',
    '- 完成后只报告做了什么；是否成功由宿主运行确定性验收决定。',
  ].join('\n');
}

export function createCodexWorkerExecutor(options: CodexWorkerExecutorOptions): WorkerExecutor {
  return {
    async execute(lease, { signal } = {}): Promise<WorkerExecutionResult> {
      const response = await options.invoker.execute({
        prompt: buildCodexWorkerPrompt(lease),
        model: options.model?.trim() || undefined,
        cwd: lease.assignment.path,
        signal,
      });
      if (!response.text.trim()) {
        return { status: 'failed', error: 'Codex Worker 没有返回最终消息' };
      }

      const verdict = await options.acceptance.evaluate({ lease, response, signal });
      const evidenceIds = [...new Set((verdict.evidenceIds ?? []).map((id) => id.trim()).filter(Boolean))];
      if (!verdict.passed) {
        return {
          status: 'failed',
          ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
          ...(verdict.acceptanceId ? { acceptanceId: verdict.acceptanceId } : {}),
          error: verdict.failureReason?.trim() || '宿主验收失败',
        };
      }
      if (evidenceIds.length === 0) {
        return { status: 'failed', error: '宿主验收通过但没有 Evidence ID' };
      }
      const acceptanceId = verdict.acceptanceId?.trim();
      if (!acceptanceId) {
        return {
          status: 'failed',
          evidenceIds,
          error: '宿主验收通过但缺少 Acceptance ID',
        };
      }
      return {
        status: 'succeeded',
        evidenceIds,
        acceptanceId,
      };
    },
  };
}
