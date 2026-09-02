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
import type { WorkerCleanupProposal } from './workerCleanup';

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
  return `cleanup:${proposal.runId}:${proposal.taskId}:a${proposal.attempt}`;
}

function findEntry(entries: readonly SideEffectRecord[], key: string): SideEffectRecord | undefined {
  return entries.find((entry) => entry.idempotencyKey === key);
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
  const parsed = await input.repository.read();
  if (parsed.status === 'needs-repair') {
    throw new SideEffectJournalError(
      'needs-repair',
      `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
    );
  }
  const existing = findEntry(parsed.journal.entries, key);
  if (existing?.status === 'receipt') return { cleaned: true, sideEffect: existing };
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
  });
  const started = startSideEffect(existing?.status === 'planned' ? existing : planned);
  const startedJournal = await input.repository.record(started);
  const startedRecord = findEntry(startedJournal.entries, key) ?? started;

  try {
    const cleaned = await input.host.confirmAndCleanup(proposal.worktreePath);
    if (!cleaned) {
      const unknown = markSideEffectUnknown(startedRecord, 'cleanup-host-gate-rejected-or-drifted');
      const journal = await input.repository.record(unknown);
      return {
        cleaned: false,
        sideEffect: findEntry(journal.entries, key) ?? unknown,
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
      sideEffect: findEntry(journal.entries, key) ?? receipt,
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
