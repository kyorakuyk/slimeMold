import type { DomainEvent } from '../domain/contracts';
import {
  createWorkerRunQueue,
  type WorkerRunQueueState,
} from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';

export interface EnqueueWorkerRunCommandInput {
  projectId: string;
  orchestrationId: string;
  runId: string;
  taskGraph: ProjectTaskGraph;
  existingRuns?: readonly WorkerRunQueueState[];
  now: string;
}

export interface EnqueueWorkerRunCommandResult {
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

/** Create the durable registry projection for one approved worker run. */
export function enqueueWorkerRunCommand(
  input: EnqueueWorkerRunCommandInput,
): EnqueueWorkerRunCommandResult {
  const projectId = requiredText(input.projectId, '项目 id');
  const orchestrationId = requiredText(input.orchestrationId, '编排 id');
  const runId = requiredText(input.runId, 'Run id');
  const existing = input.existingRuns?.find((run) => run.runId === runId);
  if (existing) {
    if (
      existing.projectId !== projectId
      || existing.orchestrationId !== orchestrationId
      || existing.taskGraphId !== input.taskGraph.id
      || existing.taskGraphVersion !== input.taskGraph.graphVersion
    ) {
      throw new Error(`Run 已存在但绑定不一致：${runId}`);
    }
    return { state: existing, events: [] };
  }

  const queue = createWorkerRunQueue({
    projectId,
    orchestrationId,
    runId,
    taskGraph: input.taskGraph,
    now: requiredText(input.now, '时间'),
  });
  return { state: queue.snapshot(), events: queue.drainEvents() };
}
