import { decodeEvidenceRecord, type EvidencePersistence, type EvidenceRecord } from '../dev/evidence';
import type { ParsedSideEffectJournal } from '../domain/sideEffects';
import type { SideEffectRecord } from '../domain/contracts';

/** Load only host-authored evidence from the durable evidence store. */
export async function loadWorkerEvidence(
  persistence: Pick<EvidencePersistence, 'load'>,
): Promise<EvidenceRecord[]> {
  const records = await persistence.load();
  return records.map((record) => decodeEvidenceRecord(record));
}

/** Merge evidence projections by immutable, host-generated evidence id. */
export function mergeWorkerEvidence(
  current: readonly EvidenceRecord[],
  incoming: readonly EvidenceRecord[],
): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const record of current) byId.set(record.id, { ...record });
  for (const record of incoming) byId.set(record.id, { ...record });
  return [...byId.values()];
}

/** Load the side-effect journal without accepting a damaged or partial parse. */
export async function loadWorkerSideEffects(
  repository: Pick<{ read: () => Promise<ParsedSideEffectJournal> }, 'read'>,
): Promise<SideEffectRecord[]> {
  const parsed = await repository.read();
  if (parsed.status === 'needs-repair') {
    throw new Error(`副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`);
  }
  return parsed.journal.entries.map((entry) => ({ ...entry }));
}

/** Merge side-effect projections by immutable idempotency key. */
export function mergeWorkerSideEffects(
  current: readonly SideEffectRecord[],
  incoming: readonly SideEffectRecord[],
): SideEffectRecord[] {
  const byKey = new Map<string, SideEffectRecord>();
  for (const record of current) byKey.set(record.idempotencyKey, { ...record });
  for (const record of incoming) byKey.set(record.idempotencyKey, { ...record });
  return [...byKey.values()];
}
