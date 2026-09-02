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

export interface WorkerCleanupExecutionHost {
  /** Host method must re-check approval, acceptance, baseline, and state signature. */
  confirmAndCleanup(path: string): Promise<boolean>;
}

export interface WorkerCleanupExecutionInput {
  proposal: WorkerCleanupProposal;
  repository: SideEffectJournalRepository;
  host: WorkerCleanupExecutionHost;
  now: string;
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
  const lineageMatches = isLegacyKey
    ? entry.taskExecutionId === undefined && entry.attemptId === undefined
      || (entry.taskExecutionId === proposal.taskExecutionId && entry.attemptId === proposal.attemptId)
    : entry.taskExecutionId === proposal.taskExecutionId && entry.attemptId === proposal.attemptId;
  return (
    entry.kind === 'worktree-cleanup' &&
    entry.runId === proposal.runId &&
    entry.taskId === proposal.taskId &&
    entry.target === proposal.worktreePath &&
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
  const parsed = await input.repository.read();
  if (parsed.status === 'needs-repair') {
    throw new SideEffectJournalError(
      'needs-repair',
      `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
    );
  }
  const existing = findEntry(parsed.journal.entries, [key, legacyKey]);
  if (existing) {
    const isLegacyKey = existing.idempotencyKey === legacyKey;
    if (!matchesProposal(existing, proposal, isLegacyKey)) {
      throw new Error(`已有 cleanup receipt 与当前 execution/attempt 不一致：${existing.idempotencyKey}`);
    }
  }
  if (existing?.status === 'receipt') {
    if (existing.receipt?.receiptId !== `${existing.idempotencyKey}:receipt`) {
      throw new Error(`已有 cleanup receipt 的 receiptId 未绑定其 key：${existing.idempotencyKey}`);
    }
    return { cleaned: true, sideEffect: existing };
  }
  if (existing?.status === 'started' || existing?.status === 'unknown') {
    throw new Error(`清理副作用需要人工核对：${key}`);
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
  const started = startSideEffect(existing?.status === 'planned' ? existing : planned);
  const startedJournal = await input.repository.record(started);
  const startedRecord = findEntry(startedJournal.entries, [key, legacyKey]) ?? started;

  try {
    const cleaned = await input.host.confirmAndCleanup(proposal.worktreePath);
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
