import type { Orchestration, OrchestrationStatus, StageLog } from '../types';
import type { WorkerQueueTask, WorkerRunQueueState } from '../domain/workerQueue';

function orchestrationStatusFor(
  runStatus: WorkerRunQueueState['status'],
  current: OrchestrationStatus,
): OrchestrationStatus {
  switch (runStatus) {
    case 'queued':
      return current === 'awaiting-confirm' ? current : 'ready';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'partial':
    case 'blocked':
      return 'failed';
    default:
      return current;
  }
}

function stageTaskStatus(tasks: WorkerQueueTask[]): StageLog['status'] | null {
  if (tasks.length === 0) return null;
  if (tasks.some((task) => task.status === 'running')) return 'running';
  if (tasks.some((task) => task.status === 'failed' || task.status === 'blocked')) return 'failed';
  if (tasks.some((task) => task.status === 'cancelled')) return 'cancelled';
  if (tasks.every((task) => task.status === 'succeeded')) return 'success';
  return 'pending';
}

function stageLogFor(
  log: StageLog,
  taskIds: readonly string[] | undefined,
  run: WorkerRunQueueState,
): StageLog {
  const tasks = (taskIds ?? [])
    .map((taskId) => run.tasks[taskId])
    .filter((task): task is WorkerQueueTask => !!task);
  const status = stageTaskStatus(tasks);
  if (!status) return log;
  const error = tasks.find((task) => task.error)?.error;
  return {
    ...log,
    status,
    runId: run.runId,
    ...(status === 'failed' && error ? { error } : { error: undefined }),
  };
}

/** Project one canonical Worker Run into its linked orchestration read model. */
export function projectWorkerRunOntoOrchestration(
  orchestration: Orchestration,
  run: WorkerRunQueueState,
): Orchestration {
  if (run.orchestrationId !== orchestration.id) return orchestration;
  const stages = orchestration.draft?.stages ?? [];
  const stageLogs = orchestration.stageLogs.map((log) => {
    const stage = stages.find((item) => item.id === log.stageId);
    return stageLogFor(log, stage?.taskIds, run);
  });
  const unresolved = stageLogs.find((log) => log.status !== 'success');
  return {
    ...orchestration,
    status: orchestrationStatusFor(run.status, orchestration.status),
    updatedAt: run.updatedAt,
    runIds: [...new Set([...orchestration.runIds, run.runId])],
    stageLogs,
    ...(unresolved ? { cursor: unresolved.stageId } : stages.length > 0 ? { cursor: stages[stages.length - 1].id } : {}),
  };
}

/** Project all Worker Runs for one project without creating a second state source. */
export function projectWorkerRunsOntoOrchestrations(
  orchestrations: readonly Orchestration[],
  runs: readonly WorkerRunQueueState[],
): Orchestration[] {
  return orchestrations.map((orchestration) =>
    runs
      .filter((run) => run.orchestrationId === orchestration.id)
      .reduce(projectWorkerRunOntoOrchestration, orchestration),
  );
}
