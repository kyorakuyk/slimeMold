import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';

export interface WorkerRecoveryDecisionPrecondition {
  projectId: string;
  projectPath: string;
  runId: string;
  capturedRun: WorkerRunQueueState;
  capturedTaskGraph: ProjectTaskGraph;
  current: {
    projectId: string | null;
    projectPath: string | null;
    workerRuns: readonly WorkerRunQueueState[];
    taskGraphs: readonly ProjectTaskGraph[];
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Reject a recovery decision captured before a same-project state mutation. */
export function assertWorkerRecoveryDecisionPrecondition(
  input: WorkerRecoveryDecisionPrecondition,
): void {
  if (input.current.projectId !== input.projectId || input.current.projectPath !== input.projectPath) {
    throw new Error('项目在 recovery 决定期间发生切换');
  }
  const currentRun = input.current.workerRuns.find((run) => run.runId === input.runId);
  if (!currentRun) throw new Error(`Worker Run 在 recovery 决定期间丢失：${input.runId}`);
  if (stableJson(currentRun) !== stableJson(input.capturedRun)) {
    throw new Error(`Worker Run 在 recovery 决定期间发生变化：${input.runId}`);
  }
  const currentTaskGraph = input.current.taskGraphs.find((graph) => (
    graph.id === input.capturedTaskGraph.id
    && graph.graphVersion === input.capturedTaskGraph.graphVersion
  ));
  if (!currentTaskGraph) {
    throw new Error(`TaskGraph 在 recovery 决定期间发生变化：${input.runId}`);
  }
  if (stableJson(currentTaskGraph) !== stableJson(input.capturedTaskGraph)) {
    throw new Error(`TaskGraph 在 recovery 决定期间发生变化：${input.runId}`);
  }
}
