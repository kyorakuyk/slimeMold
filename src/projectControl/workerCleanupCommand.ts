import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { assertTaskExecutionLineage, createAttemptId, createTaskExecutionId } from '../domain/execution';
import { workerCleanupEffectKey } from './workerCleanup';

export interface MarkWorkerTaskCleanedInput {
  state: WorkerRunQueueState;
  taskId: string;
  receiptId: string;
  taskExecutionId: string;
  attemptId: string;
  receipt: SideEffectRecord;
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
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) throw new Error('任务缺少有效 attempt');
  const expectedTaskExecutionId = task.taskExecutionId ?? createTaskExecutionId(input.state.runId, taskId);
  const expectedAttemptId = task.currentAttemptId ?? createAttemptId(expectedTaskExecutionId, task.attempt);
  assertTaskExecutionLineage({
    runId: input.state.runId,
    taskId,
    taskExecutionId: expectedTaskExecutionId,
    attemptId: expectedAttemptId,
    attempt: task.attempt,
  });
  if (input.taskExecutionId !== expectedTaskExecutionId) {
    throw new Error(`cleanup receipt 的 taskExecutionId 已过期：${taskId}`);
  }
  if (input.attemptId !== expectedAttemptId) {
    throw new Error(`cleanup receipt 的 attemptId 已过期：${taskId}`);
  }
  if (
    input.receipt.status !== 'receipt'
    || input.receipt.receipt?.receiptId !== receiptId
    || input.receipt.runId !== input.state.runId
    || input.receipt.taskId !== taskId
    || input.receipt.taskExecutionId !== expectedTaskExecutionId
    || input.receipt.attemptId !== expectedAttemptId
    || input.receipt.idempotencyKey !== workerCleanupEffectKey(expectedTaskExecutionId, expectedAttemptId)
  ) {
    throw new Error(`cleanup receipt 与当前 Task execution/attempt 不一致：${taskId}`);
  }

  const state: WorkerRunQueueState = {
    ...input.state,
    updatedAt: now,
    tasks: {
      ...input.state.tasks,
      [taskId]: {
        ...task,
        taskExecutionId: expectedTaskExecutionId,
        currentAttemptId: expectedAttemptId,
        cleanupStatus: 'cleaned',
        cleanupReceiptId: receiptId,
        updatedAt: now,
      },
    },
  };
  const event: DomainEvent = {
    eventId: `${decisionId}:task-cleaned:${expectedTaskExecutionId}`,
    streamId: input.state.projectId,
    sequence: 1,
    aggregateType: 'TaskExecution',
    aggregateId: expectedTaskExecutionId,
    aggregateVersion: 1,
    eventType: 'TaskCleaned',
    schemaVersion: 1,
    payload: {
      runId: input.state.runId,
      taskId,
      taskExecutionId: expectedTaskExecutionId,
      attempt: task.attempt,
      attemptId: expectedAttemptId,
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
