import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types/orchestration';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';

export interface WorkerRunTransitionProjectionInput {
  currentWorkerRuns: readonly WorkerRunQueueState[];
  currentOrchestrations: readonly Orchestration[];
  transition: WorkerRunQueueState;
}

export interface WorkerRunTransitionProjection {
  nextWorkerRuns: WorkerRunQueueState[];
  nextOrchestrations: Orchestration[];
}

/** Purely compose the state projection for one already-admitted Worker transition. */
export function projectWorkerRunTransition(
  input: WorkerRunTransitionProjectionInput,
): WorkerRunTransitionProjection {
  const nextWorkerRuns = input.currentWorkerRuns.map((run) => (
    run.runId === input.transition.runId ? input.transition : run
  ));
  return {
    nextWorkerRuns,
    nextOrchestrations: projectWorkerRunsOntoOrchestrations(
      input.currentOrchestrations,
      nextWorkerRuns,
    ),
  };
}
