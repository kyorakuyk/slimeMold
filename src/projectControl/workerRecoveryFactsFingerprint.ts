import {
  WORKER_RECOVERY_FACTS_SCHEMA,
} from './workerRecoveryFactsTypes';
import type {
  WorkerRecoveryFactsInput,
  WorkerRecoveryFactsV1,
} from './workerRecoveryFactsTypes';
import {
  buildWorkerRecoveryFactsV1,
  normalizeWorkerRecoveryReceiptFactV1,
} from './workerRecoveryFactsSource';
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
  const factsCanonical = canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(input));
  const terminalReceiptFacts = input.sideEffects
    .filter((effect) => effect.status === 'receipt' && effect.receipt !== undefined)
    .map((effect) => ({
      idempotencyKey: effect.idempotencyKey,
      kind: effect.kind,
      target: effect.target,
      inputHash: effect.inputHash,
      runId: effect.runId,
      taskId: effect.taskId,
      taskExecutionId: effect.taskExecutionId,
      attemptId: effect.attemptId,
      recovery: effect.recovery,
      receipt: normalizeWorkerRecoveryReceiptFactV1(effect.receipt!),
    }))
    .sort((left, right) => left.idempotencyKey < right.idempotencyKey ? -1 : left.idempotencyKey > right.idempotencyKey ? 1 : 0);
  const canonical = `${factsCanonical}\nterminal-receipts:${canonicalizeJsonValue(terminalReceiptFacts)}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 recovery facts SHA-256');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `${WORKER_RECOVERY_FACTS_SCHEMA}:sha256:${hex}`;
}
