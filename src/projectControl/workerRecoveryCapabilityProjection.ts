import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunRecovery } from './workerRunRuntime';
import {
  buildWorkerRunRecoveryPlan,
  type WorkerRunRecoveryDecision,
} from './workerSideEffects';

export type WorkerRecoveryAction = Exclude<WorkerRunRecoveryDecision, 'inspect'>;

export interface WorkerRecoveryCapabilityProjectionInput {
  run: WorkerRunQueueState;
  recovery: WorkerRunRecovery;
  taskGraph: ProjectTaskGraph | null | undefined;
  sideEffects: readonly SideEffectRecord[];
}

const ACTIONABLE_REASONS: ReadonlySet<WorkerRunRecovery['reason']> = new Set([
  'failed-tasks',
  'unfinished-worker-lease',
  'cleanup-unknown',
]);

const ACTIONS: readonly WorkerRecoveryAction[] = ['retry', 'skip'];

/**
 * Project the canonical recovery plan into currently clickable UI actions.
 * This is a capability hint only; the recovery command revalidates the plan.
 */
export function projectWorkerRecoveryActions(
  input: WorkerRecoveryCapabilityProjectionInput,
): readonly WorkerRecoveryAction[] {
  const { run, recovery, taskGraph } = input;
  if (!ACTIONABLE_REASONS.has(recovery.reason)) return [];
  if (!taskGraph || recovery.runId !== run.runId || recovery.projectId !== run.projectId) return [];
  if (taskGraph.id !== run.taskGraphId || taskGraph.graphVersion !== run.taskGraphVersion) return [];

  const failedTaskIds = Object.values(run.tasks)
    .filter((task) => task.status === 'failed' || task.status === 'running')
    .map((task) => task.taskId);
  try {
    const plan = buildWorkerRunRecoveryPlan(
      run.runId,
      { schemaVersion: 1, entries: input.sideEffects.map((effect) => ({ ...effect })) },
      failedTaskIds,
      run,
    );
    return ACTIONS.filter((action) => plan.allowedDecisions.includes(action));
  } catch {
    return [];
  }
}
