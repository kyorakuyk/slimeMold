import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId, parseAttemptId } from '../domain/execution';
import { markWorkerTaskCleaned } from './workerCleanupCommand';
import {
  cleanupReceiptHasTrustedNativeReadback,
  cleanupReceiptMatchesWorkerTask,
} from './workerCleanupReceiptTrust';

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export interface WorkerCleanupReceiptReconciliation {
  runs: WorkerRunQueueState[];
  events: ReturnType<typeof markWorkerTaskCleaned>['events'];
  migrations: Array<{ legacyKey: string; replacement: SideEffectRecord }>;
}

/** Reconcile a durable successful cleanup receipt into the current Worker projection. */
export function reconcileSuccessfulCleanupReceipts(
  runs: readonly WorkerRunQueueState[],
  effects: readonly SideEffectRecord[],
): WorkerCleanupReceiptReconciliation {
  const nextRuns = [...runs];
  const events: ReturnType<typeof markWorkerTaskCleaned>['events'] = [];
  const migrations: Array<{ legacyKey: string; replacement: SideEffectRecord }> = [];
  for (const run of runs) {
    let nextRun = run;
    for (const [taskId, task] of Object.entries(run.tasks)) {
      if (task.cleanupStatus === 'cleaned' || !task.worktreePath || task.attempt < 1) continue;
      const taskExecutionId = task.taskExecutionId ?? createTaskExecutionId(run.runId, taskId);
      const attemptId = task.currentAttemptId ?? createAttemptId(taskExecutionId, task.attempt);
      const canonicalKey = `cleanup:${attemptId}`;
      const legacyKey = `cleanup:${run.runId}:${taskId}:a${task.attempt}`;
      const matchingReceipts = effects.filter((entry) => (
        entry.kind === 'worktree-cleanup'
        && (entry.idempotencyKey === canonicalKey || entry.idempotencyKey === legacyKey)
        && entry.status === 'receipt'
        && entry.recovery === 'skip'
        && entry.receipt?.outcome === 'succeeded'
      ));
      if (matchingReceipts.length > 1) continue;
      const receipt = matchingReceipts[0];
      const sideEffectReceipt = receipt?.receipt;
      const stateSignature = sideEffectReceipt?.outputHash;
      if (!receipt || !stateSignature) continue;
      const cleanup = sideEffectReceipt?.cleanup;
      if (!cleanup
        || !sideEffectReceipt.observedAt || !isCanonicalTimestamp(sideEffectReceipt.observedAt)
        || !isCanonicalTimestamp(cleanup.hostVerifiedAt)
        || !cleanupReceiptHasTrustedNativeReadback(receipt)) continue;
      const isLegacy = receipt.idempotencyKey === legacyKey;
      const normalizedReceipt = isLegacy
        ? {
            ...receipt,
            idempotencyKey: canonicalKey,
            taskExecutionId,
            attemptId,
            receipt: { ...sideEffectReceipt, receiptId: `${canonicalKey}:receipt` },
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
        if (isLegacy) migrations.push({ legacyKey, replacement: normalizedReceipt });
      } catch {
        // A receipt that does not match the current task is not trusted for migration.
      }
    }
    const index = nextRuns.findIndex((item) => item.runId === run.runId);
    if (index >= 0) nextRuns[index] = nextRun;
  }
  return { runs: nextRuns, events, migrations };
}

function cleanupLineageKey(effect: SideEffectRecord): string | undefined {
  if (!effect.runId || !effect.taskId) return undefined;
  if (effect.attemptId) {
    try {
      const parsed = parseAttemptId(effect.attemptId);
      return `${effect.runId}:${effect.taskId}:a${parsed.attempt}`;
    } catch {
      return `${effect.runId}:${effect.taskId}:${effect.attemptId}`;
    }
  }
  const legacyPrefix = `cleanup:${effect.runId}:${effect.taskId}:a`;
  if (effect.idempotencyKey.startsWith(legacyPrefix)) {
    return `${effect.runId}:${effect.taskId}:a${effect.idempotencyKey.slice(legacyPrefix.length)}`;
  }
  return `${effect.runId}:${effect.taskId}:${effect.idempotencyKey}`;
}

export function cleanupUnknownRunIds(
  effects: readonly SideEffectRecord[],
  runs: readonly WorkerRunQueueState[] = [],
): Set<string> {
  const runIds = new Set(
    effects
      .filter((entry) => entry.kind === 'worktree-cleanup'
        && (
          entry.status === 'unknown'
          || entry.recovery === 'needs-user'
          || (
            entry.status === 'receipt'
            && entry.recovery === 'skip'
            && entry.receipt?.outcome === 'succeeded'
            && !cleanupReceiptHasTrustedNativeReadback(entry)
          )
        )
        && !!entry.runId)
      .map((entry) => entry.runId as string),
  );
  const grouped = new Map<string, SideEffectRecord[]>();
  for (const effect of effects) {
    if (effect.kind !== 'worktree-cleanup' || !effect.runId || !effect.taskId) continue;
    const key = cleanupLineageKey(effect);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), effect]);
  }
  for (const group of grouped.values()) {
    const keys = new Set(group.map((effect) => effect.idempotencyKey));
    if (keys.size > 1 && group.some((effect) => effect.idempotencyKey.startsWith('cleanup:'))) {
      for (const effect of group) if (effect.runId) runIds.add(effect.runId);
    }
  }
  for (const run of runs) {
    for (const [taskId, task] of Object.entries(run.tasks)) {
      if (task.cleanupStatus !== 'cleaned') continue;
      try {
        const taskExecutionId = createTaskExecutionId(run.runId, taskId);
        const attemptId = createAttemptId(taskExecutionId, task.attempt);
        const key = `cleanup:${attemptId}`;
        const matching = effects.filter((effect) => effect.idempotencyKey === key);
        if (task.taskExecutionId !== taskExecutionId
          || task.currentAttemptId !== attemptId
          || matching.length !== 1
          || !task.cleanupReceiptId
          || !cleanupReceiptMatchesWorkerTask({
            effect: matching[0],
            runId: run.runId,
            taskId,
            taskExecutionId,
            attemptId,
            receiptId: task.cleanupReceiptId,
            task,
          })) {
          runIds.add(run.runId);
        }
      } catch {
        runIds.add(run.runId);
      }
    }
  }
  return runIds;
}
