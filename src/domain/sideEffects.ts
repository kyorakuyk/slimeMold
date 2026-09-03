import {
  markSideEffectUnknown,
  type SideEffectRecord,
  type SideEffectReceipt,
} from './contracts';
import {
  type EventStoreAdapter,
  type EventStoreLock,
} from './eventStore';

export const SIDE_EFFECT_JOURNAL_RELATIVE_PATH = '.slimemold/runs/side-effects.json';
export const SIDE_EFFECT_LOCK_RELATIVE_PATH = '.slimemold/runs/side-effects.json.lock';

export interface SideEffectJournal {
  schemaVersion: 1;
  entries: SideEffectRecord[];
}

export type SideEffectJournalParseStatus = 'empty' | 'ok' | 'needs-repair';

export interface ParsedSideEffectJournal {
  status: SideEffectJournalParseStatus;
  journal: SideEffectJournal;
  invalidIndex?: number;
  reason?: string;
}

export type SideEffectJournalErrorCode = 'needs-repair' | 'conflict';

export class SideEffectJournalError extends Error {
  constructor(
    public readonly code: SideEffectJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SideEffectJournalError';
  }
}

export function createEmptySideEffectJournal(): SideEffectJournal {
  return { schemaVersion: 1, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is SideEffectRecord['status'] {
  return value === 'planned' || value === 'started' || value === 'receipt' || value === 'unknown';
}

function isRecovery(value: unknown): value is SideEffectRecord['recovery'] {
  return value === 'retry' || value === 'skip' || value === 'needs-user';
}

function decodeReceipt(value: unknown): SideEffectReceipt | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('receipt 必须是对象');
  if (typeof value.receiptId !== 'string' || !value.receiptId.trim()) {
    throw new Error('receipt.receiptId 无效');
  }
  if (typeof value.observedAt !== 'string' || !value.observedAt.trim()) {
    throw new Error('receipt.observedAt 无效');
  }
  if (value.outputHash !== undefined && typeof value.outputHash !== 'string') {
    throw new Error('receipt.outputHash 无效');
  }
  if (value.outcome !== undefined && value.outcome !== 'succeeded' && value.outcome !== 'failed') {
    throw new Error('receipt.outcome 无效');
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('receipt.error 无效');
  }
  return {
    receiptId: value.receiptId,
    observedAt: value.observedAt,
    ...(typeof value.outputHash === 'string' ? { outputHash: value.outputHash } : {}),
    ...(value.outcome === 'succeeded' || value.outcome === 'failed' ? { outcome: value.outcome } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function decodeRecord(value: unknown): SideEffectRecord {
  if (!isRecord(value)) throw new Error('副作用记录必须是对象');
  if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim()) {
    throw new Error('idempotencyKey 无效');
  }
  if (typeof value.kind !== 'string' || !value.kind.trim()) throw new Error('kind 无效');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target 无效');
  if (typeof value.inputHash !== 'string' || !value.inputHash.trim()) throw new Error('inputHash 无效');
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !value.runId.trim())) {
    throw new Error('runId 无效');
  }
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId.trim())) {
    throw new Error('taskId 无效');
  }
  if (value.taskExecutionId !== undefined && (typeof value.taskExecutionId !== 'string' || !value.taskExecutionId.trim())) {
    throw new Error('taskExecutionId 无效');
  }
  if (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !value.attemptId.trim())) {
    throw new Error('attemptId 无效');
  }
  if (!isStatus(value.status)) throw new Error('status 无效');
  if (!isRecovery(value.recovery)) throw new Error('recovery 无效');
  if (value.unknownReason !== undefined && typeof value.unknownReason !== 'string') {
    throw new Error('unknownReason 无效');
  }
  const receipt = decodeReceipt(value.receipt);
  if (value.status === 'receipt' && !receipt) throw new Error('receipt 状态必须带 receipt');
  if (value.status === 'receipt' && !receipt?.outcome) throw new Error('receipt 状态必须带 outcome');
  if (value.status === 'unknown' && value.recovery !== 'needs-user') {
    throw new Error('unknown 状态必须 needs-user');
  }
  return {
    idempotencyKey: value.idempotencyKey,
    kind: value.kind,
    target: value.target,
    inputHash: value.inputHash,
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    ...(typeof value.taskExecutionId === 'string' ? { taskExecutionId: value.taskExecutionId } : {}),
    ...(typeof value.attemptId === 'string' ? { attemptId: value.attemptId } : {}),
    status: value.status,
    recovery: value.recovery,
    ...(receipt ? { receipt } : {}),
    ...(typeof value.unknownReason === 'string' ? { unknownReason: value.unknownReason } : {}),
  };
}

export function parseSideEffectJournal(
  text: string | null | undefined,
): ParsedSideEffectJournal {
  if (!text || !text.trim()) {
    return { status: 'empty', journal: createEmptySideEffectJournal() };
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error('journal schema 无效');
    }
    const entries: SideEffectRecord[] = [];
    for (let index = 0; index < value.entries.length; index += 1) {
      try {
        const entry = decodeRecord(value.entries[index]);
        const existing = entries.find((item) => item.idempotencyKey === entry.idempotencyKey);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(entry)) {
            throw new Error(`重复 idempotencyKey 内容不同：${entry.idempotencyKey}`);
          }
          continue;
        }
        entries.push(entry);
      } catch (error) {
        return {
          status: 'needs-repair',
          journal: { schemaVersion: 1, entries },
          invalidIndex: index,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { status: 'ok', journal: { schemaVersion: 1, entries } };
  } catch (error) {
    return {
      status: 'needs-repair',
      journal: createEmptySideEffectJournal(),
      invalidIndex: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function serializeSideEffectJournal(journal: SideEffectJournal): string {
  return JSON.stringify({ schemaVersion: 1, entries: journal.entries });
}

function sameIdentity(left: SideEffectRecord, right: SideEffectRecord): boolean {
  const leftHasLineage = left.taskExecutionId !== undefined || left.attemptId !== undefined;
  const rightHasLineage = right.taskExecutionId !== undefined || right.attemptId !== undefined;
  const lineageSame = !leftHasLineage && !rightHasLineage
    || (
      left.taskExecutionId !== undefined
      && right.taskExecutionId !== undefined
      && left.attemptId !== undefined
      && right.attemptId !== undefined
      && left.taskExecutionId === right.taskExecutionId
      && left.attemptId === right.attemptId
    );
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.kind === right.kind &&
    left.target === right.target &&
    left.inputHash === right.inputHash &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    lineageSame
  );
}

function sameRecord(left: SideEffectRecord, right: SideEffectRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Insert or advance one effect. Replayed/stale lifecycle records are no-ops;
 * reusing an idempotency key for a different operation is a hard conflict.
 */
export function recordSideEffect(
  journal: SideEffectJournal,
  record: SideEffectRecord,
): SideEffectJournal {
  const index = journal.entries.findIndex((item) => item.idempotencyKey === record.idempotencyKey);
  if (index < 0) return { ...journal, entries: [...journal.entries, { ...record }] };

  const existing = journal.entries[index];
  if (!sameIdentity(existing, record)) {
    throw new SideEffectJournalError(
      'conflict',
      `idempotencyKey 已绑定其它副作用：${record.idempotencyKey}`,
    );
  }
  if (sameRecord(existing, record)) return journal;

  const terminal = existing.status === 'receipt';
  if (terminal) return journal;
  if (existing.status === 'unknown') return journal;
  if (existing.status === 'started' && record.status === 'planned') return journal;

  const entries = [...journal.entries];
  entries[index] = { ...record };
  return { ...journal, entries };
}

/** A process restart turns an unreceipted operation into an explicit user decision. */
export function recoverInterruptedSideEffect(
  record: SideEffectRecord,
  reason = 'process-restarted-before-receipt',
): SideEffectRecord {
  if (record.status !== 'started') return record;
  return markSideEffectUnknown(record, reason);
}

function joinPath(root: string, relative: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  return normalizedRoot ? `${normalizedRoot}/${relative}` : relative;
}

export class SideEffectJournalRepository {
  public readonly path: string;
  private readonly lockPath: string;

  constructor(
    private readonly adapter: EventStoreAdapter,
    root: string,
  ) {
    this.path = joinPath(root, SIDE_EFFECT_JOURNAL_RELATIVE_PATH);
    this.lockPath = joinPath(root, SIDE_EFFECT_LOCK_RELATIVE_PATH);
  }

  async read(): Promise<ParsedSideEffectJournal> {
    return parseSideEffectJournal(await this.adapter.readText(this.path));
  }

  async record(record: SideEffectRecord): Promise<SideEffectJournal> {
    const lock: EventStoreLock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseSideEffectJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const next = recordSideEffect(parsed.journal, record);
      if (next !== parsed.journal) {
        await this.adapter.writeTextAtomic(this.path, serializeSideEffectJournal(next));
      }
      return next;
    } finally {
      await lock.release();
    }
  }

  /** Replace one explicitly validated legacy key; generic record() never renames identities. */
  async migrateLegacyRecord(
    legacyKey: string,
    replacement: SideEffectRecord,
  ): Promise<SideEffectJournal> {
    const lock: EventStoreLock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseSideEffectJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const legacyIndex = parsed.journal.entries.findIndex((entry) => entry.idempotencyKey === legacyKey);
      if (legacyIndex < 0) throw new SideEffectJournalError('conflict', `legacy 副作用记录不存在：${legacyKey}`);
      const canonicalIndex = parsed.journal.entries.findIndex(
        (entry) => entry.idempotencyKey === replacement.idempotencyKey,
      );
      const entries = [...parsed.journal.entries];
      if (canonicalIndex >= 0) {
        if (!sameRecord(entries[canonicalIndex], replacement)) {
          throw new SideEffectJournalError('conflict', `canonical 副作用记录已存在但内容不同：${replacement.idempotencyKey}`);
        }
        entries.splice(legacyIndex, 1);
      } else {
        entries[legacyIndex] = { ...replacement };
      }
      const next = { ...parsed.journal, entries };
      await this.adapter.writeTextAtomic(this.path, serializeSideEffectJournal(next));
      return next;
    } finally {
      await lock.release();
    }
  }
}
