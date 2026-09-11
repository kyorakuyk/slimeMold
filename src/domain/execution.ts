export type TaskDefinitionId = string;
export type TaskExecutionId = string;
export type AttemptId = string;

/** Cross-host limit for a single Worker branch/path basename. */
export const WORKER_IDENTITY_MAX_LENGTH = 200;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  if (normalized !== value) throw new Error(`${field} 必须使用 canonical 形式，不能包含首尾空白`);
  return value;
}

function encodeIdentityPart(value: string, field: string): string {
  return encodeURIComponent(requiredText(value, field));
}

export function assertTaskExecutionId(value: string): TaskExecutionId {
  const executionId = requiredText(value, 'task execution id');
  const prefix = 'task-execution:';
  if (!executionId.startsWith(prefix)) {
    throw new Error(`task execution id 不是 canonical 形式：${executionId}`);
  }
  const parts = executionId.slice(prefix.length).split(':');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`task execution id 不是 canonical 形式：${executionId}`);
  }
  let runId: string;
  let taskId: string;
  try {
    runId = decodeURIComponent(parts[0]);
    taskId = decodeURIComponent(parts[1]);
  } catch {
    throw new Error(`task execution id 包含无效编码：${executionId}`);
  }
  if (createTaskExecutionId(runId, taskId) !== executionId) {
    throw new Error(`task execution id 不是 canonical 形式：${executionId}`);
  }
  return executionId;
}

export interface ParsedAttemptId {
  taskExecutionId: TaskExecutionId;
  attempt: number;
}

export function parseAttemptId(value: string): ParsedAttemptId {
  const attemptId = requiredText(value, 'attempt id');
  const marker = ':attempt-';
  const markerIndex = attemptId.lastIndexOf(marker);
  if (markerIndex <= 0) throw new Error(`attempt id 不是 canonical 形式：${attemptId}`);
  const taskExecutionId = assertTaskExecutionId(attemptId.slice(0, markerIndex));
  const attemptText = attemptId.slice(markerIndex + marker.length);
  const attempt = Number(attemptText);
  if (!/^\d+$/.test(attemptText) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`attempt id 不是 canonical 形式：${attemptId}`);
  }
  if (createAttemptId(taskExecutionId, attempt) !== attemptId) {
    throw new Error(`attempt id 不是 canonical 形式：${attemptId}`);
  }
  return { taskExecutionId, attempt };
}

/** Encode a canonical attempt identity using only Git-safe worker basename characters. */
export function workerIdentitySegment(value: AttemptId): string {
  parseAttemptId(value);
  let hex = '';
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).padStart(2, '0');
  }
  const segment = `w-${hex}`;
  if (segment.length > WORKER_IDENTITY_MAX_LENGTH) {
    throw new Error(`Worker identity 过长：${segment.length}`);
  }
  return segment;
}

export interface TaskExecutionLineageInput {
  runId: string;
  taskId: TaskDefinitionId;
  taskExecutionId?: string;
  attemptId?: string;
  attempt?: number;
}

export function assertTaskExecutionLineage(input: TaskExecutionLineageInput): ParsedAttemptId {
  const taskExecutionId = createTaskExecutionId(input.runId, input.taskId);
  if (input.taskExecutionId !== taskExecutionId) {
    throw new Error(`taskExecutionId 与 runId/taskId 不一致：${input.taskExecutionId ?? '<missing>'}`);
  }
  if (!input.attemptId) throw new Error('attemptId 缺失');
  const parsed = parseAttemptId(input.attemptId);
  if (parsed.taskExecutionId !== taskExecutionId) {
    throw new Error(`attemptId 与 taskExecutionId 不一致：${input.attemptId}`);
  }
  if (input.attempt !== undefined && input.attempt !== parsed.attempt) {
    throw new Error(`attempt 与 attemptId 不一致：${input.attempt}`);
  }
  return parsed;
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
  const executionId = assertTaskExecutionId(taskExecutionId);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`attempt 必须是大于 0 的整数：${attempt}`);
  }
  return `${executionId}:attempt-${attempt}`;
}
