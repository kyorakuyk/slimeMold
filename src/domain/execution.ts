export type TaskDefinitionId = string;
export type TaskExecutionId = string;
export type AttemptId = string;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function encodeIdentityPart(value: string, field: string): string {
  return encodeURIComponent(requiredText(value, field));
}

/** Build a deterministic identity for one task definition in one Run. */
export function createTaskExecutionId(
  runId: string,
  taskId: TaskDefinitionId,
): TaskExecutionId {
  return `task-execution:${encodeIdentityPart(runId, 'run id')}:${encodeIdentityPart(taskId, 'task id')}`;
}

/** Build a deterministic identity for one retry attempt of a task execution. */
export function createAttemptId(
  taskExecutionId: TaskExecutionId,
  attempt: number,
): AttemptId {
  const executionId = requiredText(taskExecutionId, 'task execution id');
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt 必须是大于 0 的整数：${attempt}`);
  }
  return `${executionId}:attempt-${attempt}`;
}
