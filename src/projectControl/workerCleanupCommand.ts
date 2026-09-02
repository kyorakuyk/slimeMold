import type { DomainEvent } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';

export interface MarkWorkerTaskCleanedInput {
  state: WorkerRunQueueState;
  taskId: string;
  receiptId: string;
  decisionId: string;
  now: string;
}

export interface MarkWorkerTaskCleanedResult {
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

/** Project a successful host cleanup into the durable Worker task state. */
export function markWorkerTaskCleaned(
  input: MarkWorkerTaskCleanedInput,
): MarkWorkerTaskCleanedResult {
  const taskId = requiredText(input.taskId, 'task id');
  const receiptId = requiredText(input.receiptId, 'receipt id');
  const decisionId = requiredText(input.decisionId, 'decision id');
  const now = requiredText(input.now, '时间');
  const task = input.state.tasks[taskId];
  if (!task) throw new Error(`队列中不存在任务：${taskId}`);
  if (task.status !== 'succeeded') throw new Error('只有 succeeded 任务才能标记清理完成');
  if (task.cleanupStatus === 'cleaned') throw new Error(`任务已经标记清理完成：${taskId}`);

  const state: WorkerRunQueueState = {
    ...input.state,
    updatedAt: now,
    tasks: {
      ...input.state.tasks,
      [taskId]: {
        ...task,
        cleanupStatus: 'cleaned',
        cleanupReceiptId: receiptId,
        updatedAt: now,
      },
    },
  };
  const event: DomainEvent = {
    eventId: `${decisionId}:task-cleaned:${taskId}`,
    streamId: input.state.projectId,
    sequence: 1,
    aggregateType: 'Task',
    aggregateId: taskId,
    aggregateVersion: 1,
    eventType: 'TaskCleaned',
    schemaVersion: 1,
    payload: {
      runId: input.state.runId,
      taskId,
      receiptId,
      cleanupStatus: 'cleaned',
    },
    actor: 'user',
    occurredAt: now,
    correlationId: input.state.runId,
    source: {
      objectId: input.state.taskGraphId,
      objectVersion: input.state.taskGraphVersion,
    },
    sensitivity: 'normal',
  };
  return { state, events: [event] };
}
