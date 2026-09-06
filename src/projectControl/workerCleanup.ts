import type { AcceptanceRecord } from '../dev/session';
import { normalizeAbsolutePath, pathComparisonKey } from '../dev/path-utils';
import type { WorkerQueueTask, WorkerRunQueueState } from '../domain/workerQueue';
import type { SideEffectRecord } from '../domain/contracts';
import { assertTaskExecutionLineage, createAttemptId, createTaskExecutionId } from '../domain/execution';

export interface WorkerCleanupProposalReady {
  status: 'ready';
  runId: string;
  taskId: string;
  attempt: number;
  taskExecutionId: string;
  attemptId: string;
  worktreeId: string;
  branch: string;
  branchRevision?: string;
  worktreePath: string;
  baseRevision: string;
  stateSignature: string;
  acceptanceId: string;
  orchestrationId: string;
  stageId: string;
  approvalStatus?: 'pending' | 'approved';
}

export interface WorkerCleanupProposalBlocked {
  status: 'blocked';
  runId: string;
  taskId: string;
  reason: string;
}

export interface WorkerCleanupProposalCleaned {
  status: 'cleaned';
  runId: string;
  taskId: string;
  attempt: number;
  taskExecutionId: string;
  attemptId: string;
  receiptId: string;
}

export type WorkerCleanupProposal =
  | WorkerCleanupProposalReady
  | WorkerCleanupProposalBlocked
  | WorkerCleanupProposalCleaned;

export interface BuildWorkerCleanupProposalInput {
  run: WorkerRunQueueState;
  task: WorkerQueueTask;
  acceptance?: AcceptanceRecord;
  sideEffects: readonly SideEffectRecord[];
  isWorktreeTracked?: (path: string) => boolean;
  computeWorktreeSignature: (path: string) => Promise<string>;
}

export interface WorkerCleanupHost {
  approveCleanup(
    path: string,
    options: {
      worktreeId: string;
      branch: string;
      branchRevision?: string;
      branchRevisionRequired?: boolean;
      runId: string;
      taskId: string;
      taskExecutionId: string;
      attemptId: string;
      baseRevision: string;
      stateSignature: string;
      acceptanceId: string;
      orchestrationId: string;
      stageId: string;
    },
  ): void;
  confirmAndCleanup(path: string): Promise<boolean>;
}

export function workerCleanupEffectKey(_taskExecutionId: string, attemptId: string): string {
  return `cleanup:${attemptId}`;
}

function blocked(runId: string, taskId: string, reason: string): WorkerCleanupProposalBlocked {
  return { status: 'blocked', runId, taskId, reason };
}

function resolveTaskLineage(
  run: WorkerRunQueueState,
  task: WorkerQueueTask,
): { ok: true; taskExecutionId: string; attemptId: string } | { ok: false; reason: string } {
  const taskExecutionId = createTaskExecutionId(run.runId, task.taskId);
  if (task.taskExecutionId && task.taskExecutionId !== taskExecutionId) {
    return { ok: false, reason: 'taskExecutionId 与 Run/Task 不一致，不能清理' };
  }
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) {
    return { ok: false, reason: '任务缺少有效 attempt，不能生成清理提案' };
  }
  const attemptId = createAttemptId(taskExecutionId, task.attempt);
  try {
    assertTaskExecutionLineage({
      runId: run.runId,
      taskId: task.taskId,
      taskExecutionId,
      attemptId: task.currentAttemptId ?? attemptId,
      attempt: task.attempt,
    });
  } catch {
    return { ok: false, reason: 'attemptId 与 Run/Task/attempt 不一致，不能清理' };
  }
  return { ok: true, taskExecutionId, attemptId };
}

/** Build a cleanup proposal without changing the worktree or approval state. */
export async function buildWorkerCleanupProposal(
  input: BuildWorkerCleanupProposalInput,
): Promise<WorkerCleanupProposal> {
  const { run, task, acceptance } = input;
  const taskId = task.taskId;
  const durableBranchCleanup = task.worktreeStatus === 'orphaned' || task.worktreeStatus === 'registration-pending';
  if (task.cleanupStatus === 'cleaned') {
    if (task.cleanupReceiptId) {
      const lineage = resolveTaskLineage(run, task);
      if (!lineage.ok) return blocked(run.runId, taskId, lineage.reason);
      const cleanupKey = workerCleanupEffectKey(lineage.taskExecutionId, lineage.attemptId);
      const receipt = input.sideEffects.find((effect) => effect.idempotencyKey === cleanupKey);
      if (!receipt || receipt.status !== 'receipt'
        || receipt.kind !== 'worktree-cleanup'
        || receipt.runId !== run.runId
        || receipt.taskId !== taskId
        || receipt.taskExecutionId !== lineage.taskExecutionId
        || receipt.attemptId !== lineage.attemptId
        || receipt.receipt?.receiptId !== `${cleanupKey}:receipt`
        || receipt.receipt.outcome !== 'succeeded'
        || receipt.recovery !== 'skip'
        || receipt.receipt.outputHash === undefined
        || receipt.inputHash !== `${task.baseRevision ?? ''}:${receipt.receipt.outputHash}`
        || receipt.receipt.receiptId !== task.cleanupReceiptId) {
        return blocked(run.runId, taskId, 'cleaned 任务缺少与当前 attempt 精确匹配的 cleanup receipt');
      }
      return {
        status: 'cleaned',
        runId: run.runId,
        taskId,
        attempt: task.attempt,
        taskExecutionId: lineage.taskExecutionId,
        attemptId: lineage.attemptId,
        receiptId: task.cleanupReceiptId,
      };
    }
    return blocked(run.runId, taskId, '任务标记为 cleaned 但缺少 cleanup receipt');
  }
  if (task.status !== 'succeeded') {
    return blocked(run.runId, taskId, '只有宿主验收成功的任务才能生成清理提案');
  }
  if (task.evidenceIds.length === 0) {
    return blocked(run.runId, taskId, '任务缺少 Evidence ID，不能生成清理提案');
  }
  if (!task.acceptanceId || !acceptance) {
    return blocked(run.runId, taskId, '任务缺少宿主 acceptance 记录，不能生成清理提案');
  }
  if (!task.worktreeId || !task.worktreePath || !task.branch || !task.baseRevision) {
    return blocked(run.runId, taskId, '任务缺少 worktree 或 baseRevision，不能生成清理提案');
  }
  if (durableBranchCleanup && !task.branchRevision?.trim()) {
    return blocked(run.runId, taskId, 'orphan/registration-pending 缺少持久化 branchRevision，拒绝清理');
  }
  const lineage = resolveTaskLineage(run, task);
  if (!lineage.ok) return blocked(run.runId, taskId, lineage.reason);

  const orchestrationId = run.orchestrationId ?? run.runId;
  const path = normalizeAbsolutePath(task.worktreePath);
  const acceptanceLineageMatches = acceptance.runId === run.runId
    && acceptance.taskId === taskId
    && acceptance.taskExecutionId === lineage.taskExecutionId
    && acceptance.attemptId === lineage.attemptId;
  const acceptanceMatches =
    acceptance.acceptanceId === task.acceptanceId &&
    acceptance.passed &&
    acceptance.orchestrationId === orchestrationId &&
    pathComparisonKey(acceptance.worktreePath) === pathComparisonKey(path) &&
    acceptanceLineageMatches;
  if (!acceptanceMatches) {
    return blocked(run.runId, taskId, 'acceptance 未通过或未绑定当前 Run/Task/worktree/attempt');
  }
  if (!durableBranchCleanup && input.isWorktreeTracked && !input.isWorktreeTracked(task.worktreePath)) {
    return blocked(run.runId, taskId, 'worktree 未被当前宿主登记，不能清理');
  }

  const stateSignature = durableBranchCleanup
    ? task.cleanupStateSignature
    : await input.computeWorktreeSignature(task.worktreePath);
  if (!stateSignature?.trim()) {
    return blocked(run.runId, taskId, durableBranchCleanup
      ? 'orphan/registration-pending 缺少持久化 cleanup state signature，拒绝清理'
      : '无法取得 worktree 状态签名，拒绝清理');
  }
  return {
    status: 'ready',
    runId: run.runId,
    taskId,
    attempt: task.attempt,
    taskExecutionId: lineage.taskExecutionId,
    attemptId: lineage.attemptId,
    worktreeId: task.worktreeId,
    branch: task.branch,
    ...(durableBranchCleanup ? { branchRevision: task.branchRevision } : {}),
    worktreePath: task.worktreePath,
    baseRevision: task.baseRevision,
    stateSignature,
    acceptanceId: task.acceptanceId,
    orchestrationId,
    stageId: acceptance.stageId,
  };
}

/** Record a one-shot host approval bound to the proposal fingerprint. */
export function approveWorkerCleanupProposal(
  proposal: WorkerCleanupProposal,
  host: WorkerCleanupHost,
): void {
  if (proposal.status === 'blocked') throw new Error(`清理提案不可批准：${proposal.reason}`);
  if (proposal.status === 'cleaned') throw new Error('清理提案已经完成，不能重复批准');
  host.approveCleanup(proposal.worktreePath, {
    worktreeId: proposal.worktreeId,
    branch: proposal.branch,
    branchRevision: proposal.branchRevision,
    branchRevisionRequired: proposal.branchRevision !== undefined,
    runId: proposal.runId,
    taskId: proposal.taskId,
    taskExecutionId: proposal.taskExecutionId,
    attemptId: proposal.attemptId,
    baseRevision: proposal.baseRevision,
    stateSignature: proposal.stateSignature,
    acceptanceId: proposal.acceptanceId,
    orchestrationId: proposal.orchestrationId,
    stageId: proposal.stageId,
  });
}

/** Consume the host's second signature/acceptance gate; never deletes directly. */
export async function cleanupApprovedWorker(
  proposal: WorkerCleanupProposal,
  host: WorkerCleanupHost,
): Promise<boolean> {
  if (proposal.status !== 'ready') return false;
  return host.confirmAndCleanup(proposal.worktreePath);
}
