import {
  completeSideEffect,
  createSideEffect,
  markSideEffectUnknown,
  startSideEffect,
  type SideEffectRecord,
} from '../domain/contracts';
import {
  SideEffectJournalError,
  SideEffectJournalRepository,
} from '../domain/sideEffects';
import { workerCleanupEffectKey, type WorkerCleanupProposal } from './workerCleanup';
import { pathComparisonKey } from '../dev/path-utils';

export interface WorkerCleanupExecutionHost {
  /** Host method must re-check approval, acceptance, baseline, and state signature. */
  confirmAndCleanup(path: string, signal?: AbortSignal): Promise<boolean>;
}

export interface WorkerCleanupExecutionInput {
  proposal: WorkerCleanupProposal;
  repository: SideEffectJournalRepository;
  host: WorkerCleanupExecutionHost;
  now: string;
  signal?: AbortSignal;
}

export interface WorkerCleanupExecutionResult {
  cleaned: boolean;
  sideEffect: SideEffectRecord;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Worker cleanup 已取消');
  error.name = 'AbortError';
  throw error;
}

function effectKey(proposal: Extract<WorkerCleanupProposal, { status: 'ready' }>): string {
  return workerCleanupEffectKey(proposal.taskExecutionId, proposal.attemptId);
}

function legacyEffectKey(proposal: Extract<WorkerCleanupProposal, { status: 'ready' }>): string {
  return `cleanup:${proposal.runId}:${proposal.taskId}:a${proposal.attempt}`;
}

function findEntry(
  entries: readonly SideEffectRecord[],
  keys: readonly string[],
): SideEffectRecord | undefined {
  return entries.find((entry) => keys.includes(entry.idempotencyKey));
}

function matchesProposal(
  entry: SideEffectRecord,
  proposal: Extract<WorkerCleanupProposal, { status: 'ready' }>,
  isLegacyKey: boolean,
): boolean {
  const hasLineage = entry.taskExecutionId !== undefined || entry.attemptId !== undefined;
  const lineageMatches = isLegacyKey
    ? (!hasLineage
      || (entry.taskExecutionId !== undefined && entry.attemptId !== undefined
        && entry.taskExecutionId === proposal.taskExecutionId
        && entry.attemptId === proposal.attemptId))
    : entry.taskExecutionId === proposal.taskExecutionId && entry.attemptId === proposal.attemptId;
  return (
    entry.kind === 'worktree-cleanup' &&
    entry.runId === proposal.runId &&
    entry.taskId === proposal.taskId &&
    pathComparisonKey(entry.target) === pathComparisonKey(proposal.worktreePath) &&
    entry.inputHash === `${proposal.baseRevision}:${proposal.stateSignature}` &&
    lineageMatches
  );
}

/** Execute only after the caller has already recorded the explicit host approval. */
export async function executeWorkerCleanupWithReceipt(
  input: WorkerCleanupExecutionInput,
): Promise<WorkerCleanupExecutionResult> {
  if (input.proposal.status === 'blocked') throw new Error(`清理提案不可执行：${input.proposal.reason}`);
  if (input.proposal.status === 'cleaned') throw new Error('清理提案已经完成，不能重复执行');
  const proposal = input.proposal;
  const now = requiredText(input.now, '时间');
  const key = effectKey(proposal);
  const legacyKey = legacyEffectKey(proposal);
  throwIfAborted(input.signal);
  const parsed = await input.repository.read();
  throwIfAborted(input.signal);
  if (parsed.status === 'needs-repair') {
    throw new SideEffectJournalError(
      'needs-repair',
      `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
    );
  }
  const existing = findEntry(parsed.journal.entries, [key, legacyKey]);
  const isLegacyKey = existing?.idempotencyKey === legacyKey;
  if (existing) {
    if (!matchesProposal(existing, proposal, isLegacyKey)) {
      throw new Error(`已有 cleanup receipt 与当前 execution/attempt 不一致：${existing.idempotencyKey}`);
    }
  }
  if (existing?.status === 'receipt') {
    if (
      existing.receipt?.receiptId !== `${existing.idempotencyKey}:receipt`
      || existing.recovery !== 'skip'
      || existing.receipt.outcome !== 'succeeded'
      || existing.receipt.outputHash !== proposal.stateSignature
    ) {
      throw new Error(`已有 cleanup receipt 的 outcome/receiptId 未绑定其 key：${existing.idempotencyKey}`);
    }
    if (isLegacyKey) {
      const canonicalKey = key;
      const migrated: SideEffectRecord = {
        ...existing,
        idempotencyKey: canonicalKey,
        taskExecutionId: proposal.taskExecutionId,
        attemptId: proposal.attemptId,
        receipt: {
          ...existing.receipt,
          receiptId: `${canonicalKey}:receipt`,
        },
      };
      const migratedJournal = await input.repository.migrateLegacyRecord(legacyKey, migrated);
      return {
        cleaned: true,
        sideEffect: findEntry(migratedJournal.entries, [canonicalKey]) ?? migrated,
      };
    }
    return { cleaned: true, sideEffect: existing };
  }
  if (existing?.status === 'started' || existing?.status === 'unknown') {
    throw new Error(`清理副作用需要人工核对：${key}`);
  }

  let currentEntry = existing;
  if (existing?.status === 'planned' && isLegacyKey) {
    const migratedJournal = await input.repository.migrateLegacyRecord(legacyKey, {
      ...existing,
      idempotencyKey: key,
      taskExecutionId: proposal.taskExecutionId,
      attemptId: proposal.attemptId,
    });
    currentEntry = findEntry(migratedJournal.entries, [key]);
  }
  const planned = createSideEffect({
    idempotencyKey: key,
    kind: 'worktree-cleanup',
    target: proposal.worktreePath,
    inputHash: `${proposal.baseRevision}:${proposal.stateSignature}`,
    runId: proposal.runId,
    taskId: proposal.taskId,
    taskExecutionId: proposal.taskExecutionId,
    attemptId: proposal.attemptId,
  });
  const started = startSideEffect(currentEntry?.status === 'planned' ? currentEntry : planned);
  const startedJournal = await input.repository.record(started);
  throwIfAborted(input.signal);
  const startedRecord = findEntry(startedJournal.entries, [key]) ?? started;

  try {
    throwIfAborted(input.signal);
    const cleaned = input.signal
      ? await input.host.confirmAndCleanup(proposal.worktreePath, input.signal)
      : await input.host.confirmAndCleanup(proposal.worktreePath);
    throwIfAborted(input.signal);
    if (!cleaned) {
      const unknown = markSideEffectUnknown(startedRecord, 'cleanup-host-gate-rejected-or-drifted');
      const journal = await input.repository.record(unknown);
      return {
        cleaned: false,
        sideEffect: findEntry(journal.entries, [key, legacyKey]) ?? unknown,
      };
    }
    const receipt = completeSideEffect(startedRecord, {
      receiptId: `${key}:receipt`,
      observedAt: now,
      outputHash: proposal.stateSignature,
      outcome: 'succeeded',
    });
    const journal = await input.repository.record(receipt);
    return {
      cleaned: true,
      sideEffect: findEntry(journal.entries, [key, legacyKey]) ?? receipt,
    };
  } catch (cause) {
    try {
      await input.repository.record(
        markSideEffectUnknown(startedRecord, 'cleanup-threw-before-receipt'),
      );
    } catch {
      // Preserve the original failure; an unreadable journal remains fail-closed.
    }
    throw cause;
  }
}
