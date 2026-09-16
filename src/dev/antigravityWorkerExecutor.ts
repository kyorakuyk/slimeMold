import type { WorkerExecutionResult, WorkerTaskLease } from '../domain/workerQueue';
import { createFeedbackRequest, type FeedbackRequest } from '../projectControl/protocol';
import type { CodexWorkerResponse, WorkerAcceptance } from './codexWorkerExecutor';
import {
  createAntigravityWorkerInvoker,
  type AntigravityMode,
  type AntigravityWorkerInvoker,
  type AntigravityWorkerInvokerOptions,
} from '../agents/providers/antigravity';

export interface AntigravityWorkerExecutorOptions extends AntigravityWorkerInvokerOptions {
  acceptance: WorkerAcceptance;
  invoker?: AntigravityWorkerInvoker;
}

function promptFor(lease: WorkerTaskLease): string {
  const { task, assignment, attempt } = lease;
  return [
    '你是 SlimeMold 的 Antigravity 实现 Worker。只在当前已分配 Worktree 内工作。',
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
    '强制边界：',
    '- 先调用 slimemold_get_task_context，再开始修改。',
    '- 只能修改当前 Worktree；不得修改依赖 Worktree、主仓库、远程资源或凭据。',
    '- 用 slimemold_report_progress 汇报进度。',
    '- 完成后调用 slimemold_submit_attempt_result；这只表示请求 Host Acceptance，不代表成功。',
    '- 遇到歧义调用 slimemold_request_feedback，不要猜测。',
  ].join('\n');
}

function feedbackFor(lease: WorkerTaskLease, summary: string): FeedbackRequest {
  const feedbackId = `feedback-antigravity-${lease.task.id}-${lease.attempt}`;
  const reference = {
    projectId: lease.projectId,
    kind: 'acceptance' as const,
    id: `acceptance-${lease.task.id}`,
    version: lease.task.version,
  };
  return createFeedbackRequest({
    schemaVersion: 1,
    feedbackId,
    projectId: lease.projectId,
    taskId: lease.task.id,
    parentTaskId: lease.task.id,
    attemptId: lease.attemptId,
    contextVersion: lease.contextPack?.contextVersion ?? 1,
    ambiguity: `Antigravity Attempt 请求人工反馈：${summary}`,
    affectedScope: lease.task.scope,
    affectedAcceptance: [reference],
    options: [
      { id: 'inspect-and-retry', label: '检查当前 Worktree 后重新尝试' },
      { id: 'skip-task', label: '跳过当前 Task 并保留现场' },
    ],
    recommendation: '先检查 Antigravity session 目录和当前 Worktree，再决定 retry 或 skip。',
    blocking: true,
    requestedBy: {
      projectId: lease.projectId,
      agentId: 'runtime.antigravity',
      role: 'worker',
      taskId: lease.task.id,
    },
    sourceRefs: [reference],
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
}

export function createAntigravityWorkerExecutor(
  options: AntigravityWorkerExecutorOptions,
) {
  const invoker = options.invoker ?? createAntigravityWorkerInvoker(options);
  return {
    async execute(
      lease: WorkerTaskLease,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<WorkerExecutionResult> {
      const response = await invoker.execute({
        prompt: promptFor(lease),
        cwd: lease.assignment.path,
        operationId: `antigravity-${lease.attemptId.replace(/[^A-Za-z0-9_.-]/g, '-')}`,
        context: {
          task: lease.task,
          attempt: lease.attempt,
          attemptId: lease.attemptId,
          contextPack: lease.contextPack ?? null,
          dependencyArtifacts: lease.dependencyArtifacts ?? [],
        },
        signal,
      });
      if (response.outcome === 'blocked') {
        return {
          status: 'waiting-feedback',
          feedbackRequest: feedbackFor(lease, response.text),
        };
      }
      const modelResponse: CodexWorkerResponse = { text: response.text };
      const verdict = await options.acceptance.evaluate({ lease, response: modelResponse, signal });
      const evidenceIds = [...new Set((verdict.evidenceIds ?? []).map((id) => id.trim()).filter(Boolean))];
      if (!verdict.passed) {
        return {
          status: 'failed',
          ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
          ...(verdict.acceptanceId ? { acceptanceId: verdict.acceptanceId } : {}),
          error: verdict.failureReason?.trim() || 'Antigravity Host Acceptance 失败',
        };
      }
      if (evidenceIds.length === 0) return { status: 'failed', error: 'Host Acceptance 通过但没有 Evidence ID' };
      if (!verdict.acceptanceId?.trim()) {
        return { status: 'failed', evidenceIds, error: 'Host Acceptance 通过但缺少 Acceptance ID' };
      }
      return { status: 'succeeded', evidenceIds, acceptanceId: verdict.acceptanceId.trim() };
    },
  };
}

export type { AntigravityMode };
