import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId, parseAttemptId } from '../domain/execution';
import { pathComparisonKey } from '../dev/path-utils';
import { markWorkerTaskCleaned } from './workerCleanupCommand';

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
      const hostReadback = cleanup?.hostReadback;
      if (!cleanup || !hostReadback
        || !sideEffectReceipt.observedAt || !isCanonicalTimestamp(sideEffectReceipt.observedAt)
        || !isCanonicalTimestamp(cleanup.hostVerifiedAt)
        || hostReadback.authority !== 'native'
        || pathComparisonKey(hostReadback.worktreePath) !== pathComparisonKey(cleanup.worktreePath)
        || hostReadback.branch !== cleanup.branch
        || hostReadback.branchRevision !== cleanup.branchRevision
        || hostReadback.targetIdentity !== cleanup.targetIdentity
        || hostReadback.finalStatus !== 'absent') continue;
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

function cleanupReceiptHostReadbackIsTrusted(effect: SideEffectRecord): boolean {
  const cleanup = effect.receipt?.cleanup;
  const hostReadback = cleanup?.hostReadback;
  return !!cleanup
    && !!hostReadback
    && hostReadback.authority === 'native'
    && hostReadback.finalStatus === 'absent'
    && cleanup.finalStatus === 'absent'
    && pathComparisonKey(hostReadback.worktreePath) === pathComparisonKey(cleanup.worktreePath)
    && hostReadback.branch === cleanup.branch
    && hostReadback.branchRevision === cleanup.branchRevision
    && hostReadback.targetIdentity === cleanup.targetIdentity;
}

export function cleanupUnknownRunIds(effects: readonly SideEffectRecord[]): Set<string> {
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
            && !cleanupReceiptHostReadbackIsTrusted(entry)
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
  return runIds;
}
