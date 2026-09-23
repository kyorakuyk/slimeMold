import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { markWorkerTaskCleaned } from './workerCleanupCommand';

export interface WorkerCleanupReceiptReconciliation {
  runs: WorkerRunQueueState[];
  events: ReturnType<typeof markWorkerTaskCleaned>['events'];
}

/** Reconcile a durable successful cleanup receipt into the current Worker projection. */
export function reconcileSuccessfulCleanupReceipts(
  runs: readonly WorkerRunQueueState[],
  effects: readonly SideEffectRecord[],
): WorkerCleanupReceiptReconciliation {
  const nextRuns = [...runs];
  const events: ReturnType<typeof markWorkerTaskCleaned>['events'] = [];
  for (const run of runs) {
    let nextRun = run;
    for (const [taskId, task] of Object.entries(run.tasks)) {
      if (task.cleanupStatus === 'cleaned' || !task.worktreePath || task.attempt < 1) continue;
      const taskExecutionId = task.taskExecutionId ?? createTaskExecutionId(run.runId, taskId);
      const attemptId = task.currentAttemptId ?? createAttemptId(taskExecutionId, task.attempt);
      const canonicalKey = `cleanup:${attemptId}`;
      const legacyKey = `cleanup:${run.runId}:${taskId}:a${task.attempt}`;
      const receipt = effects.find((entry) => (
        entry.kind === 'worktree-cleanup'
        && (entry.idempotencyKey === canonicalKey || entry.idempotencyKey === legacyKey)
        && entry.status === 'receipt'
        && entry.recovery === 'skip'
        && entry.receipt?.outcome === 'succeeded'
      ));
      const stateSignature = receipt?.receipt?.outputHash;
      if (!receipt || !stateSignature) continue;
      const isLegacy = receipt.idempotencyKey === legacyKey;
      const normalizedReceipt = isLegacy
        ? {
            ...receipt,
            idempotencyKey: canonicalKey,
            taskExecutionId,
            attemptId,
            receipt: receipt.receipt
              ? { ...receipt.receipt, receiptId: `${canonicalKey}:receipt` }
              : receipt.receipt,
          }
        : receipt;
      try {
        const reconciled = markWorkerTaskCleaned({
          state: nextRun,
          taskId,
          receiptId: normalizedReceipt.receipt?.receiptId ?? '',
          taskExecutionId,
          attemptId,
          stateSignature,
          receipt: normalizedReceipt,
          decisionId: `cleanup-reconcile:${normalizedReceipt.receipt?.receiptId ?? attemptId}`,
          now: normalizedReceipt.receipt?.observedAt ?? new Date().toISOString(),
        });
        nextRun = reconciled.state;
        events.push(...reconciled.events);
      } catch {
        // A receipt that does not match the current task is not trusted for migration.
      }
    }
    const index = nextRuns.findIndex((item) => item.runId === run.runId);
    if (index >= 0) nextRuns[index] = nextRun;
  }
  return { runs: nextRuns, events };
}

export function cleanupUnknownRunIds(effects: readonly SideEffectRecord[]): Set<string> {
  return new Set(
    effects
      .filter((entry) => entry.kind === 'worktree-cleanup'
        && (
          entry.status === 'unknown'
          || entry.recovery === 'needs-user'
          || (
            entry.status === 'receipt'
            && entry.recovery === 'skip'
            && entry.receipt?.outcome === 'succeeded'
            && !entry.receipt.cleanup
          )
        )
        && !!entry.runId)
      .map((entry) => entry.runId as string),
  );
}
