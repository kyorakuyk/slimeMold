import {
  WORKER_RECOVERY_FACTS_SCHEMA,
} from './workerRecoveryFactsTypes';
import type {
  WorkerRecoveryFactsInput,
  WorkerRecoveryFactsV1,
} from './workerRecoveryFactsTypes';
import { buildWorkerRecoveryFactsV1 } from './workerRecoveryFactsSource';
import { normalizeFactsDto } from './workerRecoveryFactsNormalization';
import { canonicalizeJsonValue } from './workerRecoveryFactsCanonicalJson';
import { validateFactsDto } from './workerRecoveryFactsDtoValidation';

export { WORKER_RECOVERY_FACTS_SCHEMA, buildWorkerRecoveryFactsV1 };
export type {
  WorkerRecoveryEffectFactV1,
  WorkerRecoveryFactsInput,
  WorkerRecoveryFactsSchema,
  WorkerRecoveryFactsV1,
  WorkerRecoveryProjectTaskFactV1,
  WorkerRecoveryTaskFactV1,
} from './workerRecoveryFactsTypes';

export function canonicalizeWorkerRecoveryFactsV1(facts: WorkerRecoveryFactsV1): string {
  validateFactsDto(facts);
  const normalized = normalizeFactsDto(facts);
  validateFactsDto(normalized);
  return canonicalizeJsonValue(normalized);
}

export async function fingerprintWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): Promise<string> {
  const canonical = canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(input));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 recovery facts SHA-256');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `${WORKER_RECOVERY_FACTS_SCHEMA}:sha256:${hex}`;
}
