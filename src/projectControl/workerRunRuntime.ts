import {
  restoreWorkerRunQueue,
  runWorkerQueue,
  type WorkerRunQueueState,
  type RunWorkerQueueOptions,
  type WorkerTaskQueue,
} from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunConsistencyIssue, WorkerRunConsistencyReport } from './workerRunConsistency';

export type WorkerRunRecoveryReason =
  | 'project-mismatch'
  | 'task-graph-missing'
  | 'task-graph-duplicate'
  | 'task-graph-version-mismatch'
  | 'duplicate-run'
  | 'unfinished-worker-lease'
  | 'invalid-state'
  | 'event-stream-invalid'
  | 'event-stream-drift'
  | 'cleanup-unknown';

export interface WorkerRunRecovery {
  runId: string;
  projectId: string;
  reason: WorkerRunRecoveryReason;
  message: string;
}

export interface WorkerRunRuntimeRegistry {
  projectId: string;
  queues: Map<string, WorkerTaskQueue>;
  recoveries: WorkerRunRecovery[];
}

export interface RehydrateWorkerRunRegistryInput {
  projectId: string;
  taskGraphs: readonly ProjectTaskGraph[];
  runs: readonly WorkerRunQueueState[];
  consistency?: WorkerRunConsistencyReport;
}

function recovery(
  run: WorkerRunQueueState,
  reason: WorkerRunRecoveryReason,
  message: string,
): WorkerRunRecovery {
  return {
    runId: run.runId,
    projectId: run.projectId,
    reason,
    message,
  };
}

function consistencyRecovery(
  run: WorkerRunQueueState,
  report: WorkerRunConsistencyReport | undefined,
): WorkerRunRecovery | null {
  if (!report || report.ok) return null;
  const issues = report.issues.filter(
    (item: WorkerRunConsistencyIssue) => !item.runId || item.runId === run.runId,
  );
  if (issues.length === 0) return null;
  const invalid = issues.some((item) =>
    item.code === 'invalid-event-stream' || item.code === 'event-stream-project-mismatch',
  );
  return recovery(
    run,
    invalid ? 'event-stream-invalid' : 'event-stream-drift',
    `Worker 事实源需要人工核对：${issues.map((item) => item.message).join('；')}`,
  );
}

/** Rebuild executable queue objects without resuming side effects. */
export function rehydrateWorkerRunRegistry(
  input: RehydrateWorkerRunRegistryInput,
): WorkerRunRuntimeRegistry {
  const queues = new Map<string, WorkerTaskQueue>();
  const recoveries: WorkerRunRecovery[] = [];
  const seenRunIds = new Set<string>();
  const duplicateGraphIds = new Set<string>();
  const graphIds = new Set<string>();
  for (const graph of input.taskGraphs) {
    if (graphIds.has(graph.id)) duplicateGraphIds.add(graph.id);
    graphIds.add(graph.id);
  }
  const graphsById = new Map(input.taskGraphs.map((graph) => [graph.id, graph]));

  for (const run of input.runs) {
    if (seenRunIds.has(run.runId)) {
      recoveries.push(recovery(run, 'duplicate-run', `Run id 重复，拒绝恢复：${run.runId}`));
      continue;
    }
    seenRunIds.add(run.runId);
    if (run.projectId !== input.projectId) {
      recoveries.push(recovery(run, 'project-mismatch', `Run 不属于当前项目：${run.projectId}`));
      continue;
    }
    if (duplicateGraphIds.has(run.taskGraphId)) {
      recoveries.push(recovery(run, 'task-graph-duplicate', `任务图 id 重复，拒绝恢复：${run.taskGraphId}`));
      continue;
    }
    const consistencyIssue = consistencyRecovery(run, input.consistency);
    if (consistencyIssue) {
      recoveries.push(consistencyIssue);
      continue;
    }
    const graph = graphsById.get(run.taskGraphId);
    if (!graph) {
      recoveries.push(recovery(run, 'task-graph-missing', `任务图不存在：${run.taskGraphId}`));
      continue;
    }
    if (graph.graphVersion !== run.taskGraphVersion) {
      recoveries.push(recovery(
        run,
        'task-graph-version-mismatch',
        `任务图版本漂移：Run=${run.taskGraphVersion}，当前=${graph.graphVersion}`,
      ));
      continue;
    }
    const hasUnfinishedLease = run.status === 'running'
      || Object.values(run.tasks).some((task) => task.status === 'running');
    if (hasUnfinishedLease) {
      recoveries.push(recovery(
        run,
        'unfinished-worker-lease',
        '检测到未闭合 Worker lease，等待副作用账本核对后才能恢复',
      ));
      continue;
    }
    try {
      queues.set(run.runId, restoreWorkerRunQueue({ taskGraph: graph, state: run }));
    } catch (cause) {
      recoveries.push(recovery(
        run,
        'invalid-state',
        `Worker Run 状态无效，拒绝恢复：${cause instanceof Error ? cause.message : String(cause)}`,
      ));
    }
  }

  return { projectId: input.projectId, queues, recoveries };
}

/** Return only a TaskGraph-validated snapshot for destructive cleanup proposal generation. */
export function getRestoredWorkerRunForCleanup(input: {
  projectId: string;
  taskGraphs: readonly ProjectTaskGraph[];
  run: WorkerRunQueueState;
  consistency?: WorkerRunConsistencyReport;
}): WorkerRunQueueState | null {
  const registry = rehydrateWorkerRunRegistry({
    projectId: input.projectId,
    taskGraphs: input.taskGraphs,
    runs: [input.run],
    consistency: input.consistency,
  });
  if (registry.recoveries.some((item) => item.runId === input.run.runId)) return null;
  return registry.queues.get(input.run.runId)?.snapshot() ?? null;
}

let activeRegistry: WorkerRunRuntimeRegistry | null = null;
const activeRunIds = new Set<string>();

export function installWorkerRunRuntime(
  input: RehydrateWorkerRunRegistryInput,
): WorkerRunRuntimeRegistry {
  activeRegistry = rehydrateWorkerRunRegistry(input);
  return activeRegistry;
}

/** Execute one explicitly selected restored Run and forward every durable transition. */
export async function runActiveWorkerRun(
  runId: string,
  options: Omit<RunWorkerQueueOptions, 'onTransition'>,
  onUpdate: (update: { state: WorkerRunQueueState; events: ReturnType<WorkerTaskQueue['drainEvents']> }) => Promise<void> | void,
): Promise<WorkerRunQueueState> {
  if (!activeRegistry) throw new Error('没有已安装的 Worker Run runtime');
  const queue = activeRegistry.queues.get(runId);
  if (!queue) {
    const recovery = activeRegistry.recoveries.find((item) => item.runId === runId);
    throw new Error(recovery?.message ?? `Worker Run 不可执行：${runId}`);
  }
  if (activeRunIds.has(runId)) throw new Error(`Run 正在执行：${runId}`);
  activeRunIds.add(runId);
  try {
    return await runWorkerQueue(queue, {
      ...options,
      onTransition: onUpdate,
    });
  } finally {
    activeRunIds.delete(runId);
  }
}

export function getActiveWorkerRunRuntime(): WorkerRunRuntimeRegistry | null {
  return activeRegistry;
}

export function clearWorkerRunRuntime(): void {
  activeRegistry = null;
  activeRunIds.clear();
}
