import type { WorkerRunQueueState } from '../domain/workerQueue';

export interface LegacyExecutionDecision {
  allowed: boolean;
  reason?: string;
}

/** Prevent the pre-Worker executor from creating a second execution path. */
export function canStartLegacyOrchestration(
  orchestrationId: string,
  workerRuns: readonly WorkerRunQueueState[],
): LegacyExecutionDecision {
  const owned = workerRuns.some((run) => run.orchestrationId === orchestrationId);
  return owned
    ? { allowed: false, reason: '该编排已由 Worker Run 接管，不能启动旧 executor' }
    : { allowed: true };
}
