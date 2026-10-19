import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerQueueTask } from '../domain/workerQueue';
import { pathComparisonKey } from '../dev/path-utils';

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Require a native absence read-back bound to one stable worktree identity. */
export function cleanupReceiptHasTrustedNativeReadback(effect: SideEffectRecord): boolean {
  const cleanup = effect.receipt?.cleanup;
  const hostReadback = cleanup?.hostReadback;
  if (!cleanup || !hostReadback
    || hostReadback.authority !== 'native'
    || !hasText(cleanup.worktreePath)
    || !hasText(cleanup.worktreeId)
    || !hasText(cleanup.targetIdentity)
    || !hasText(cleanup.branch)
    || !hasText(cleanup.branchRevision)
    || !hasText(cleanup.baseRevision)
    || !hasText(cleanup.hostVerifiedAt)
    || !hasText(hostReadback.worktreePath)
    || !hasText(hostReadback.branch)
    || !hasText(hostReadback.branchRevision)
    || !hasText(hostReadback.targetIdentity)
    || cleanup.finalStatus !== 'absent'
    || hostReadback.finalStatus !== 'absent'
    || hostReadback.branch !== cleanup.branch
    || hostReadback.branchRevision !== cleanup.branchRevision
    || hostReadback.targetIdentity !== cleanup.targetIdentity) {
    return false;
  }
  try {
    return pathComparisonKey(hostReadback.worktreePath) === pathComparisonKey(cleanup.worktreePath);
  } catch {
    return false;
  }
}

export function cleanupReceiptMatchesWorkerTask(input: {
  effect: SideEffectRecord;
  runId: string;
  taskId: string;
  taskExecutionId: string;
  attemptId: string;
  receiptId: string;
  task: Pick<WorkerQueueTask,
    'worktreeId' | 'worktreePath' | 'targetIdentity' | 'branch' | 'baseRevision'>;
}): boolean {
  const { effect, task } = input;
  const cleanup = effect.receipt?.cleanup;
  const outputHash = effect.receipt?.outputHash;
  const key = `cleanup:${input.attemptId}`;
  if (!cleanup || !cleanupReceiptHasTrustedNativeReadback(effect)) return false;
  if (effect.idempotencyKey !== key
    || effect.kind !== 'worktree-cleanup'
    || effect.status !== 'receipt'
    || effect.recovery !== 'skip'
    || effect.runId !== input.runId
    || effect.taskId !== input.taskId
    || effect.taskExecutionId !== input.taskExecutionId
    || effect.attemptId !== input.attemptId
    || !hasText(outputHash)
    || effect.receipt?.outcome !== 'succeeded'
    || effect.receipt.receiptId !== input.receiptId
    || effect.receipt.receiptId !== `${key}:receipt`
    || !hasText(task.worktreeId)
    || !hasText(task.worktreePath)
    || !hasText(task.targetIdentity)
    || !hasText(task.branch)
    || !hasText(task.baseRevision)
    || cleanup.worktreeId !== task.worktreeId
    || cleanup.targetIdentity !== task.targetIdentity
    || cleanup.branch !== task.branch
    || cleanup.baseRevision !== task.baseRevision
    || effect.inputHash !== `${task.baseRevision}:${outputHash}`) {
    return false;
  }
  try {
    return pathComparisonKey(effect.target) === pathComparisonKey(task.worktreePath)
      && pathComparisonKey(cleanup.worktreePath) === pathComparisonKey(task.worktreePath);
  } catch {
    return false;
  }
}
