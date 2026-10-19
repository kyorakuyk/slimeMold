import type { SideEffectRecord } from '../domain/contracts';
import { assertTaskExecutionLineage, createAttemptId, parseAttemptId } from '../domain/execution';
import type { DomainProjection } from '../domain/contracts';
import { workerCleanupEffectKey } from './workerCleanup';
import type {
  ExpectedTaskLineage,
  WorkerRunConsistencyIssue,
  WorkerRunConsistencyIssueCode,
} from './workerRunConsistencyTypes';

export function emptyProjection(): DomainProjection {
  return { lastSequence: 0, runs: {}, tasks: {}, taskExecutions: {}, attempts: {} };
}

export function issue(
  code: WorkerRunConsistencyIssueCode,
  message: string,
  identifiers: { runId?: string; taskId?: string } = {},
): WorkerRunConsistencyIssue {
  return { code, message, ...identifiers };
}

export function sameStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return [...new Set(left ?? [])].sort().join('\u0000') === [...new Set(right ?? [])].sort().join('\u0000');
}

export function recordMatchesTaskLineage(
  record: {
    runId?: string;
    taskId?: string;
    taskExecutionId?: string;
    attemptId?: string;
  },
  expected: ExpectedTaskLineage,
  currentOnly: boolean,
): boolean {
  const declaresLineage = record.runId !== undefined
    || record.taskId !== undefined
    || record.taskExecutionId !== undefined
    || record.attemptId !== undefined;
  if (!declaresLineage) return false;
  if (!record.runId || !record.taskId || !record.taskExecutionId || !record.attemptId) return false;
  if (record.runId !== expected.runId || record.taskId !== expected.taskId) return false;
  try {
    const parsed = assertTaskExecutionLineage({
      runId: expected.runId,
      taskId: expected.taskId,
      taskExecutionId: record.taskExecutionId,
      attemptId: record.attemptId,
    });
    return currentOnly ? parsed.attempt === expected.currentAttempt : parsed.attempt <= expected.currentAttempt;
  } catch {
    return false;
  }
}

function parseHistoricalAttempt(
  effect: SideEffectRecord,
  expected: ExpectedTaskLineage,
): ReturnType<typeof parseAttemptId> | undefined {
  if (!effect.attemptId) return undefined;
  try {
    const parsed = parseAttemptId(effect.attemptId);
    if (parsed.taskExecutionId !== expected.taskExecutionId || parsed.attempt >= expected.currentAttempt) return undefined;
    const expectedAttemptId = createAttemptId(expected.taskExecutionId, parsed.attempt);
    return effect.attemptId === expectedAttemptId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isHistoricalCleanupEffect(
  effect: SideEffectRecord,
  expected: ExpectedTaskLineage,
  expectedAttemptId: string,
): boolean {
  return effect.idempotencyKey === workerCleanupEffectKey(expected.taskExecutionId, expectedAttemptId)
    && effect.kind === 'worktree-cleanup'
    && !!effect.target
    && !!effect.inputHash.trim();
}

function isHistoricalWorkerExecutionEffect(
  effect: SideEffectRecord,
  expected: ExpectedTaskLineage,
  attempt: number,
): boolean {
  const expectedWorkerKey = `worker-execution:${expected.taskExecutionId}:attempt-${attempt}`;
  const expectedLegacyWorkerKey = `worker-execution:${expected.runId}:${expected.taskId}:attempt-${attempt}`;
  if (
    (effect.idempotencyKey !== expectedWorkerKey && effect.idempotencyKey !== expectedLegacyWorkerKey)
    || effect.kind !== 'worker-execution'
  ) return false;
  let hash: unknown;
  try { hash = JSON.parse(effect.inputHash); } catch { return false; }
  if (!Array.isArray(hash) || hash[0] !== expected.runId || hash[1] !== expected.taskId || hash[2] !== 1 || hash[3] !== attempt || typeof hash[4] !== 'string' || !hash[4]) return false;
  if (effect.idempotencyKey === expectedWorkerKey) {
    if (
      hash.length !== 7
      || typeof hash[5] !== 'string'
      || !hash[5]
      || typeof hash[6] !== 'string'
      || !hash[6]
    ) return false;
  } else if (hash.length !== 5) {
    return false;
  }
  return true;
}

function hasVerifiedHistoricalEffectStatus(effect: SideEffectRecord, isCleanup: boolean): boolean {
  if (effect.status === 'unknown') return effect.recovery === 'needs-user' && effect.receipt === undefined;
  return effect.status === 'receipt'
    && effect.recovery === 'skip'
    && effect.receipt?.outcome !== undefined
    && effect.receipt.receiptId === `${effect.idempotencyKey}:receipt`
    && (isCleanup ? effect.inputHash.endsWith(`:${effect.receipt.outputHash ?? ''}`) : true);
}

export function isVerifiedHistoricalEffect(
  effect: SideEffectRecord,
  expected: ExpectedTaskLineage,
): boolean {
  if (effect.runId !== expected.runId || effect.taskId !== expected.taskId || effect.taskExecutionId !== expected.taskExecutionId) return false;
  const parsed = parseHistoricalAttempt(effect, expected);
  if (!parsed) return false;
  const expectedAttemptId = createAttemptId(expected.taskExecutionId, parsed.attempt);
  const isCleanup = effect.idempotencyKey === workerCleanupEffectKey(expected.taskExecutionId, expectedAttemptId);
  const matchesEffectKind = isCleanup
    ? isHistoricalCleanupEffect(effect, expected, expectedAttemptId)
    : isHistoricalWorkerExecutionEffect(effect, expected, parsed.attempt);
  return matchesEffectKind && hasVerifiedHistoricalEffectStatus(effect, isCleanup);
}
