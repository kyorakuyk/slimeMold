export interface WorkerSuccessProvenance {
  evidenceIds: string[];
  acceptanceId: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 不能为空`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

/**
 * Normalize the evidence/acceptance pair required by every successful Worker
 * terminal fact. Fail closed for runtime results, persisted snapshots, and
 * replayed event payloads alike.
 */
export function normalizeWorkerSuccessProvenance(
  evidenceIds: readonly unknown[] | undefined,
  acceptanceId: unknown,
): WorkerSuccessProvenance {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    throw new Error('succeeded Worker Task 缺少非空 Evidence ids');
  }
  const normalizedEvidenceIds = evidenceIds.map((id) => requiredText(id, 'Evidence id'));
  if (new Set(normalizedEvidenceIds).size !== normalizedEvidenceIds.length) {
    throw new Error('succeeded Worker Task 的 Evidence ids 重复');
  }
  return {
    evidenceIds: normalizedEvidenceIds,
    acceptanceId: requiredText(acceptanceId, 'Acceptance id'),
  };
}

export function hasWorkerSuccessProvenance(input: {
  evidenceIds?: readonly unknown[];
  acceptanceId?: unknown;
}): boolean {
  try {
    normalizeWorkerSuccessProvenance(input.evidenceIds, input.acceptanceId);
    return true;
  } catch {
    return false;
  }
}

export function workerRunSuccessIsValid(
  tasks: ReadonlyArray<{
    status: string;
    evidenceIds?: readonly unknown[];
    acceptanceId?: unknown;
  }>,
): boolean {
  return tasks.length > 0
    && tasks.every((task) => task.status === 'succeeded' && hasWorkerSuccessProvenance(task));
}
