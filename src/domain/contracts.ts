import {
  assertTaskExecutionLineage,
  createAttemptId,
  createTaskExecutionId,
  type AttemptId,
  type TaskExecutionId,
} from './execution';

export type ExecutionObjective = 'cost-first' | 'quality-first' | 'speed-first' | 'balanced';
export type SandboxMode = 'workspace-write' | 'danger-full-access';
export type WorkerKind = 'planner' | 'worker';
export type DomainActor = 'user' | 'master' | 'runtime' | 'system' | `plugin:${string}`;

export interface DomainEvent<TPayload = unknown> {
  eventId: string;
  streamId: string;
  sequence: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: number;
  payload: TPayload;
  actor: DomainActor;
  occurredAt: string;
  causationId?: string;
  correlationId?: string;
  source?: {
    objectId: string;
    objectVersion: number;
  };
  sensitivity?: 'normal' | 'private';
  synthetic?: boolean;
}

export type TaskProjectionStatus = 'queued' | 'running' | 'waiting-feedback' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export type RunProjectionStatus = 'queued' | 'running' | 'partial' | 'blocked' | 'failed' | 'cancelled' | 'succeeded';

export interface TaskExecutionProjection {
  taskExecutionId: TaskExecutionId;
  taskId: string;
  runId: string;
  status: TaskProjectionStatus;
  attemptIds: AttemptId[];
  currentAttemptId?: AttemptId;
  pendingAttempt?: number;
  evidenceIds?: string[];
  acceptanceId?: string;
  feedbackId?: string;
  cleanupStatus?: 'cleaned';
  cleanupReceiptId?: string;
  error?: string;
}

export interface AttemptRecord {
  attemptId: AttemptId;
  taskExecutionId: TaskExecutionId;
  taskId: string;
  runId: string;
  attempt: number;
  status: TaskProjectionStatus | 'unknown';
  unknownReason?: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  baseRevision?: string;
  evidenceIds?: string[];
  acceptanceId?: string;
  feedbackId?: string;
  cleanupStatus?: 'cleaned';
  cleanupReceiptId?: string;
  error?: string;
}

export interface DomainProjection {
  lastSequence: number;
  runs: Record<string, { status: RunProjectionStatus }>;
  tasks: Record<string, {
    status: TaskProjectionStatus;
    runId?: string;
    evidenceIds?: string[];
    acceptanceId?: string;
    feedbackId?: string;
    cleanupStatus?: 'cleaned';
    cleanupReceiptId?: string;
  }>;
  taskExecutions: Record<string, TaskExecutionProjection>;
  attempts: Record<string, AttemptRecord>;
}

/**
 * Append-only stream invariant for the Phase 0a in-memory contract.
 * The file writer and lock live in a later adapter; this function remains pure.
 */
export function appendDomainEvent(
  events: readonly DomainEvent[],
  event: DomainEvent,
): DomainEvent[] {
  const duplicate = events.find((item) => item.eventId === event.eventId);
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
      throw new Error(`事件 id 已存在但内容不同：${event.eventId}`);
    }
    return events as DomainEvent[];
  }

  const expectedSequence = (events.at(-1)?.sequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(`事件 sequence 不连续：期望 ${expectedSequence}，实际 ${event.sequence}`);
  }

  const previousAggregate = [...events]
    .reverse()
    .find(
      (item) =>
        item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId,
    );
  const expectedAggregateVersion = (previousAggregate?.aggregateVersion ?? 0) + 1;
  if (event.aggregateVersion !== expectedAggregateVersion) {
    throw new Error(
      `聚合版本不连续：期望 ${expectedAggregateVersion}，实际 ${event.aggregateVersion}`,
    );
  }

  return [...events, event];
}

type EventPayload = Record<string, unknown>;

type TaskLineage = {
  runId: string;
  taskId: string;
  taskExecutionId: TaskExecutionId;
  attempt?: number;
  attemptId?: AttemptId;
};

function payloadRecord(value: unknown): EventPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as EventPayload
    : {};
}

function payloadText(payload: EventPayload, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function payloadIdentityText(payload: EventPayload, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  if (!value) return undefined;
  if (value.trim() !== value) {
    throw new Error(`${key} 必须使用 canonical 形式，不能包含首尾空白`);
  }
  return value;
}

function payloadPositiveInteger(payload: EventPayload, key: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return undefined;
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${key} 必须是大于 0 的整数：${String(value)}`);
  }
  return value as number;
}

function payloadAttempt(payload: EventPayload): number | undefined {
  return payloadPositiveInteger(payload, 'attempt');
}

function payloadEvidenceIds(payload: EventPayload): string[] | undefined {
  if (!Array.isArray(payload.evidenceIds)) return undefined;
  return payload.evidenceIds.filter((id): id is string => typeof id === 'string');
}

function taskIdFor(event: DomainEvent, payload: EventPayload): string | undefined {
  return payloadIdentityText(payload, 'taskId')
    ?? (event.aggregateType === 'Task' ? event.aggregateId : undefined);
}

function taskLineageFor(
  event: DomainEvent,
  payload: EventPayload,
  projection: DomainProjection,
): TaskLineage | undefined {
  const runId = payloadIdentityText(payload, 'runId');
  const taskId = taskIdFor(event, payload);
  if (!runId || !taskId) {
    if (event.aggregateType === 'TaskExecution') {
      throw new Error(`TaskExecution 事件缺少 runId/taskId：${event.eventId}`);
    }
    return undefined;
  }

  const derivedTaskExecutionId = createTaskExecutionId(runId, taskId);
  const suppliedTaskExecutionId = payloadIdentityText(payload, 'taskExecutionId');
  if (suppliedTaskExecutionId && suppliedTaskExecutionId !== derivedTaskExecutionId) {
    throw new Error(`taskExecutionId 与 runId/taskId 不一致：${suppliedTaskExecutionId}`);
  }
  const taskExecutionId = suppliedTaskExecutionId ?? derivedTaskExecutionId;
  if (event.aggregateType === 'TaskExecution' && event.aggregateId !== taskExecutionId) {
    throw new Error(`TaskExecution aggregateId 与 taskExecutionId 不一致：${event.eventId}`);
  }
  const suppliedAttemptId = payloadIdentityText(payload, 'attemptId');
  const isAttemptLifecycleEvent = event.eventType === 'TaskStarted'
    || event.eventType === 'TaskSucceeded'
    || event.eventType === 'TaskFailed'
    || event.eventType === 'TaskFeedbackRequested'
    || event.eventType === 'TaskAttemptMarkedUnknown'
    || event.eventType === 'TaskCleaned';
  const execution = projection.taskExecutions[taskExecutionId];
  const currentAttempt = execution?.currentAttemptId
    ? projection.attempts[execution.currentAttemptId]
    : undefined;
  const attempt = payloadAttempt(payload)
    ?? (isAttemptLifecycleEvent ? currentAttempt?.attempt : undefined)
    ?? (isAttemptLifecycleEvent && event.aggregateType !== 'TaskExecution' ? 1 : undefined);
  if (event.aggregateType === 'TaskExecution' && isAttemptLifecycleEvent && !suppliedAttemptId) {
    throw new Error(`TaskExecution 生命周期事件必须携带 attemptId：${event.eventId}`);
  }
  if (event.aggregateType === 'TaskExecution' && isAttemptLifecycleEvent && attempt === undefined) {
    throw new Error(`TaskExecution 生命周期事件缺少可验证 attempt：${event.eventId}`);
  }
  if (suppliedAttemptId && attempt === undefined) {
    throw new Error(`attemptId 缺少可验证的 attempt：${suppliedAttemptId}`);
  }
  const attemptId = suppliedAttemptId
    ?? (attempt === undefined ? undefined : createAttemptId(taskExecutionId, attempt));
  if (attemptId && attempt && attemptId !== createAttemptId(taskExecutionId, attempt)) {
    throw new Error(`attemptId 与 taskExecutionId/attempt 不一致：${attemptId}`);
  }
  return { runId, taskId, taskExecutionId, attempt, attemptId };
}

function taskExecutionPatch(payload: EventPayload, eventType: string): Partial<TaskExecutionProjection> {
  const evidenceIds = payloadEvidenceIds(payload);
  const acceptanceId = payloadText(payload, 'acceptanceId');
  const feedbackId = payloadText(payload, 'feedbackId');
  const error = payloadText(payload, 'error');
  const receiptId = payloadText(payload, 'receiptId');
  return {
    ...(evidenceIds !== undefined ? { evidenceIds } : {}),
    ...(acceptanceId ? { acceptanceId } : {}),
    ...(feedbackId ? { feedbackId } : {}),
    ...(error ? { error } : {}),
    ...(eventType === 'TaskCleaned' || payload.cleanupStatus === 'cleaned'
      ? { cleanupStatus: 'cleaned' as const }
      : {}),
    ...(receiptId ? { cleanupReceiptId: receiptId } : {}),
  };
}

function attemptPatch(payload: EventPayload, eventType: string): Partial<AttemptRecord> {
  const evidenceIds = payloadEvidenceIds(payload);
  const acceptanceId = payloadText(payload, 'acceptanceId');
  const feedbackId = payloadText(payload, 'feedbackId');
  const error = payloadText(payload, 'error');
  const receiptId = payloadText(payload, 'receiptId');
  return {
    ...(typeof payload.worktreeId === 'string' ? { worktreeId: payload.worktreeId } : {}),
    ...(typeof payload.worktreePath === 'string' ? { worktreePath: payload.worktreePath } : {}),
    ...(typeof payload.branch === 'string' ? { branch: payload.branch } : {}),
    ...(typeof payload.baseRevision === 'string' ? { baseRevision: payload.baseRevision } : {}),
    ...(evidenceIds !== undefined ? { evidenceIds } : {}),
    ...(acceptanceId ? { acceptanceId } : {}),
    ...(feedbackId ? { feedbackId } : {}),
    ...(error ? { error } : {}),
    ...(eventType === 'TaskCleaned' || payload.cleanupStatus === 'cleaned'
      ? { cleanupStatus: 'cleaned' as const }
      : {}),
    ...(receiptId ? { cleanupReceiptId: receiptId } : {}),
  };
}

function applyLegacyTaskProjection(
  projection: DomainProjection,
  taskId: string,
  runId: string | undefined,
  status: TaskProjectionStatus,
  eventType: string,
  payload: EventPayload,
): void {
  const base = { status, ...(runId ? { runId } : {}) };
  if (eventType === 'TaskSucceeded' || eventType === 'TaskFailed' || eventType === 'TaskFeedbackRequested') {
    const evidenceIds = payloadEvidenceIds(payload);
    const acceptanceId = payloadText(payload, 'acceptanceId');
    const feedbackId = payloadText(payload, 'feedbackId');
    projection.tasks[taskId] = {
      ...base,
      ...(evidenceIds !== undefined ? { evidenceIds } : {}),
      ...(acceptanceId ? { acceptanceId } : {}),
      ...(feedbackId ? { feedbackId } : {}),
    };
    return;
  }
  if (eventType === 'TaskCleaned') {
    const previous = projection.tasks[taskId];
    const receiptId = payloadText(payload, 'receiptId');
    projection.tasks[taskId] = {
      ...base,
      ...(previous?.evidenceIds ? { evidenceIds: previous.evidenceIds } : {}),
      ...(previous?.acceptanceId ? { acceptanceId: previous.acceptanceId } : {}),
      cleanupStatus: 'cleaned',
      ...(receiptId ? { cleanupReceiptId: receiptId } : {}),
    };
    return;
  }
  projection.tasks[taskId] = base;
}

function isTerminalAttemptStatus(status: AttemptRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function applyTaskLineageProjection(
  projection: DomainProjection,
  lineage: TaskLineage,
  status: TaskProjectionStatus,
  eventType: string,
  payload: EventPayload,
  event: DomainEvent,
): void {
  const previous = projection.taskExecutions[lineage.taskExecutionId];
  const previousAttempt = lineage.attemptId ? projection.attempts[lineage.attemptId] : undefined;
  const attemptIds = [...(previous?.attemptIds ?? [])];
  if (lineage.attemptId && !attemptIds.includes(lineage.attemptId)) attemptIds.push(lineage.attemptId);
  const nextAttempt = eventType === 'TaskQueued'
    ? payloadPositiveInteger(payload, 'nextAttempt')
    : undefined;
  const maxAttempt = previous?.attemptIds
    .map((attemptId) => projection.attempts[attemptId]?.attempt ?? 0)
    .reduce((max, attempt) => Math.max(max, attempt), 0) ?? 0;
  const currentAttempt = previous?.currentAttemptId
    ? projection.attempts[previous.currentAttemptId]
    : undefined;
  const latestAttempt = attemptIds
    .map((attemptId) => projection.attempts[attemptId])
    .filter((attempt): attempt is AttemptRecord => !!attempt)
    .sort((left, right) => right.attempt - left.attempt)[0];
  const hasExplicitAttemptIdentity = Object.prototype.hasOwnProperty.call(payload, 'attempt')
    || Object.prototype.hasOwnProperty.call(payload, 'attemptId');
  const strictAttemptLifecycle = event.aggregateType === 'TaskExecution' || hasExplicitAttemptIdentity;
  const isCompletion = eventType === 'TaskSucceeded'
    || eventType === 'TaskFailed'
    || eventType === 'TaskCleaned';
  if (eventType === 'TaskAttemptMarkedUnknown') {
    if (!previousAttempt || previous?.currentAttemptId !== lineage.attemptId || previousAttempt.status !== 'running') {
      throw new Error(`只能把当前 running Attempt 标记 unknown：${lineage.attemptId ?? '<missing>'}`);
    }
    projection.taskExecutions[lineage.taskExecutionId] = {
      ...previous,
      currentAttemptId: undefined,
      status: 'running',
      attemptIds,
    };
    projection.attempts[lineage.attemptId!] = {
      ...previousAttempt,
      status: 'unknown',
      unknownReason: payloadText(payload, 'reason') ?? 'recovery decision',
    };
    return;
  }

  if (eventType === 'TaskQueued'
    && nextAttempt === undefined
    && previous
    && (previous.attemptIds.length > 0 || previous.status !== 'queued')) {
    throw new Error(`重复 TaskQueued 缺少 retry fence：${lineage.taskExecutionId}`);
  }

  if (nextAttempt !== undefined) {
    if (previous?.pendingAttempt === nextAttempt) {
      if (previous) {
        projection.taskExecutions[lineage.taskExecutionId] = {
          ...previous,
          status: 'queued',
          currentAttemptId: undefined,
          pendingAttempt: nextAttempt,
        };
      }
      return;
    }
    if (nextAttempt !== maxAttempt + 1) {
      throw new Error(`nextAttempt 不是连续的下一次 attempt：期望 ${maxAttempt + 1}，实际 ${nextAttempt}`);
    }
    if (previous?.pendingAttempt !== undefined) {
      throw new Error(`TaskExecution 已有 pending retry：${lineage.taskExecutionId}`);
    }
    const latest = currentAttempt ?? latestAttempt;
    if (latest && !isTerminalAttemptStatus(latest.status) && latest.status !== 'unknown') {
      throw new Error(`前一个 Attempt 不是 terminal/unknown，拒绝排队 retry：${lineage.taskExecutionId}`);
    }
  }

  if (lineage.attempt !== undefined) {
    if (maxAttempt === 0 && lineage.attempt !== 1) {
      throw new Error(`首次 Attempt 必须从 1 开始：${lineage.attempt}`);
    }
    if (maxAttempt > 0) {
      if (lineage.attempt < maxAttempt || lineage.attempt > maxAttempt + 1) {
        throw new Error(`Attempt 顺序不连续：已有 ${maxAttempt}，实际 ${lineage.attempt}`);
      }
      if (lineage.attempt === maxAttempt + 1) {
        if (previous?.pendingAttempt !== lineage.attempt) {
          throw new Error(`新 Attempt 缺少对应的 queued retry fence：${lineage.attempt}`);
        }
        const active = currentAttempt ?? latestAttempt;
        if (active && !isTerminalAttemptStatus(active.status) && active.status !== 'unknown') {
          throw new Error(`前一个 Attempt 仍未结束，拒绝新 Attempt：${lineage.taskExecutionId}`);
        }
      }
    }
  }

  if (previousAttempt) {
    if (eventType === 'TaskFeedbackRequested'
      && (previous?.currentAttemptId !== lineage.attemptId || previousAttempt.status !== 'running')) {
      throw new Error(`反馈请求只能来自当前 running Attempt：${lineage.attemptId}`);
    }
    if (eventType === 'TaskFeedbackRequested' && previousAttempt.status === 'waiting-feedback') {
      throw new Error(`Attempt 已在等待反馈：${lineage.attemptId}`);
    }
    if (eventType === 'TaskStarted' && (previousAttempt.status === 'running' || isTerminalAttemptStatus(previousAttempt.status) || previousAttempt.status === 'unknown')) {
      throw new Error(`Attempt 不能重复启动或从终态 reopen：${lineage.attemptId}`);
    }
    if (isCompletion && eventType !== 'TaskCleaned' && previousAttempt.status !== 'running') {
      throw new Error(`completion 只能来自 running Attempt：${lineage.attemptId}`);
    }
    if (eventType === 'TaskCleaned' && previousAttempt.status !== 'succeeded') {
      throw new Error(`只有 succeeded Attempt 可以清理：${lineage.attemptId}`);
    }
  }

  if (strictAttemptLifecycle && isCompletion) {
    if (!previousAttempt || previous?.currentAttemptId !== lineage.attemptId) {
      throw new Error(`completion 不匹配当前 Attempt fencing token：${lineage.attemptId ?? '<missing>'}`);
    }
  }
  if (strictAttemptLifecycle && eventType === 'TaskStarted' && maxAttempt > 0 && lineage.attempt === maxAttempt) {
    throw new Error(`已存在的 Attempt 不能重新启动：${lineage.attemptId}`);
  }

  const nextExecution: TaskExecutionProjection = {
    ...previous,
    taskExecutionId: lineage.taskExecutionId,
    taskId: lineage.taskId,
    runId: lineage.runId,
    status,
    attemptIds,
    ...(nextAttempt !== undefined
      ? {
          evidenceIds: undefined,
          acceptanceId: undefined,
          feedbackId: undefined,
          cleanupStatus: undefined,
          cleanupReceiptId: undefined,
          error: undefined,
          currentAttemptId: undefined,
          pendingAttempt: nextAttempt,
        }
      : {}),
    ...(lineage.attemptId ? { currentAttemptId: lineage.attemptId } : {}),
    ...taskExecutionPatch(payload, eventType),
  };
  if (eventType === 'TaskStarted' || eventType === 'TaskBlocked' || isCompletion) delete nextExecution.pendingAttempt;
  projection.taskExecutions[lineage.taskExecutionId] = nextExecution;

  if (!lineage.attemptId || lineage.attempt === undefined) return;
  projection.attempts[lineage.attemptId] = {
    ...projection.attempts[lineage.attemptId],
    attemptId: lineage.attemptId,
    taskExecutionId: lineage.taskExecutionId,
    taskId: lineage.taskId,
    runId: lineage.runId,
    attempt: lineage.attempt,
    status,
    ...attemptPatch(payload, eventType),
  };
}

function applyImportedAttemptProjection(
  projection: DomainProjection,
  event: DomainEvent,
): void {
  const payload = payloadRecord(event.payload);
  const sourceRunId = payloadIdentityText(payload, 'runId');
  const sourceTaskId = payloadIdentityText(payload, 'taskId');
  if (
    event.aggregateType !== 'TaskExecution'
    || event.actor !== 'system'
    || event.synthetic !== true
    || !event.source
    || !event.source.objectId
    || event.source.objectId.trim() !== event.source.objectId
    || !event.correlationId?.trim()
    || !sourceRunId
    || !sourceTaskId
    || event.source.objectId !== `${event.streamId}:workerTask:${sourceRunId}:${sourceTaskId}`
    || !Number.isSafeInteger(event.source.objectVersion)
    || event.source.objectVersion < 1
  ) {
    throw new Error(`TaskAttemptImported 必须来自 synthetic system migration：${event.eventId}`);
  }
  const lineage = taskLineageFor(event, payload, projection);
  if (!lineage?.attemptId || lineage.attempt === undefined) {
    throw new Error(`TaskAttemptImported 事件缺少可验证 lineage：${event.eventId}`);
  }
  if (event.aggregateId !== lineage.taskExecutionId) {
    throw new Error(`TaskAttemptImported aggregateId 与 lineage 不一致：${event.eventId}`);
  }
  if (projection.attempts[lineage.attemptId]) {
    throw new Error(`TaskAttemptImported 重复 attempt：${lineage.attemptId}`);
  }
  const previous = projection.taskExecutions[lineage.taskExecutionId];
  const maxAttempt = previous?.attemptIds
    .map((attemptId) => projection.attempts[attemptId]?.attempt ?? 0)
    .reduce((max, attempt) => Math.max(max, attempt), 0) ?? 0;
  if (lineage.attempt !== maxAttempt + 1) {
    throw new Error(`TaskAttemptImported 顺序不连续：期望 ${maxAttempt + 1}，实际 ${lineage.attempt}`);
  }
  projection.taskExecutions[lineage.taskExecutionId] = {
    ...previous,
    taskExecutionId: lineage.taskExecutionId,
    taskId: lineage.taskId,
    runId: lineage.runId,
    status: previous?.status ?? 'queued',
    attemptIds: [...(previous?.attemptIds ?? []), lineage.attemptId],
  };
  projection.attempts[lineage.attemptId] = {
    attemptId: lineage.attemptId,
    taskExecutionId: lineage.taskExecutionId,
    taskId: lineage.taskId,
    runId: lineage.runId,
    attempt: lineage.attempt,
    status: 'unknown',
  };
}

function applyTaskEvent(
  projection: DomainProjection,
  event: DomainEvent,
  status: TaskProjectionStatus,
): void {
  const payload = payloadRecord(event.payload);
  const taskId = taskIdFor(event, payload);
  const runId = payloadIdentityText(payload, 'runId');
  if (taskId) applyLegacyTaskProjection(projection, taskId, runId, status, event.eventType, payload);
  const lineage = taskLineageFor(event, payload, projection);
  if (lineage) applyTaskLineageProjection(projection, lineage, status, event.eventType, payload, event);
}

/** Replay stable run facts plus immutable execution/attempt lineage. */
export function replayDomainEvents(events: readonly DomainEvent[]): DomainProjection {
  const projection: DomainProjection = {
    lastSequence: 0,
    runs: {},
    tasks: {},
    taskExecutions: {},
    attempts: {},
  };

  const aggregateVersions = new Map<string, number>();
  for (const event of events) {
    if (event.sequence !== projection.lastSequence + 1) {
      throw new Error(`事件流存在缺口：期望 ${projection.lastSequence + 1}，实际 ${event.sequence}`);
    }
    const aggregateKey = `${event.aggregateType}\u0000${event.aggregateId}`;
    const expectedAggregateVersion = (aggregateVersions.get(aggregateKey) ?? 0) + 1;
    if (event.aggregateVersion !== expectedAggregateVersion) {
      throw new Error(`聚合版本不连续：期望 ${expectedAggregateVersion}，实际 ${event.aggregateVersion}`);
    }
    aggregateVersions.set(aggregateKey, event.aggregateVersion);
    const payload = payloadRecord(event.payload);
    const payloadRunId = payloadIdentityText(payload, 'runId');
    if (event.aggregateType === 'Run' && payloadRunId && payloadRunId !== event.aggregateId) {
      throw new Error(`Run aggregateId 与 runId 不一致：${event.eventId}`);
    }
    const payloadTaskId = payloadIdentityText(payload, 'taskId');
    if (event.aggregateType === 'Task' && payloadTaskId && payloadTaskId !== event.aggregateId) {
      throw new Error(`Task aggregateId 与 taskId 不一致：${event.eventId}`);
    }

    switch (event.eventType) {
      case 'RunCreated':
      case 'RunQueued':
        projection.runs[event.aggregateId] = { status: 'queued' };
        break;
      case 'RunStarted':
        projection.runs[event.aggregateId] = { status: 'running' };
        break;
      case 'RunPartial':
        projection.runs[event.aggregateId] = { status: 'partial' };
        break;
      case 'RunBlocked':
        projection.runs[event.aggregateId] = { status: 'blocked' };
        break;
      case 'RunFailed':
        projection.runs[event.aggregateId] = { status: 'failed' };
        break;
      case 'RunCancelled':
        projection.runs[event.aggregateId] = { status: 'cancelled' };
        break;
      case 'RunSucceeded':
        projection.runs[event.aggregateId] = { status: 'succeeded' };
        break;
      case 'TaskQueued':
        applyTaskEvent(projection, event, 'queued');
        break;
      case 'TaskAttemptImported':
        applyImportedAttemptProjection(projection, event);
        break;
      case 'TaskAttemptMarkedUnknown':
        applyTaskEvent(projection, event, 'running');
        break;
      case 'TaskStarted':
        applyTaskEvent(projection, event, 'running');
        break;
      case 'TaskFeedbackRequested':
        applyTaskEvent(projection, event, 'waiting-feedback');
        break;
      case 'TaskSucceeded':
        applyTaskEvent(projection, event, 'succeeded');
        break;
      case 'TaskCleaned':
        applyTaskEvent(projection, event, 'succeeded');
        break;
      case 'TaskFailed':
        applyTaskEvent(projection, event, 'failed');
        break;
      case 'TaskBlocked':
        applyTaskEvent(projection, event, 'blocked');
        break;
      case 'TaskCancelled':
        applyTaskEvent(projection, event, 'cancelled');
        break;
      default:
        // Unknown events remain part of the stream; this projection simply ignores them.
        break;
    }
    projection.lastSequence = event.sequence;
  }

  return projection;
}

export interface GlobalExecutionPreferences {
  sandboxMode: SandboxMode;
  objective: ExecutionObjective;
  autoPush: boolean;
  managerMerge: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface ProjectExecutionPolicyOverride {
  projectId: string;
  sandboxMode?: SandboxMode;
  objective?: ExecutionObjective;
  autoPush?: boolean;
  managerMerge?: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface RunExecutionPolicyOverride {
  sandboxMode?: SandboxMode;
  objective?: ExecutionObjective;
  autoPush?: boolean;
  managerMerge?: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface EffectiveExecutionPolicy {
  projectId: string;
  sandboxMode: SandboxMode;
  objective: ExecutionObjective;
  autoPush: boolean;
  managerMerge: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface ResolvedExecutionPolicy {
  policy: EffectiveExecutionPolicy;
  sources: {
    sandboxMode: 'global' | 'project' | 'run';
    objective: 'global' | 'project' | 'run';
    autoPush: 'global' | 'project' | 'run';
    managerMerge: 'global' | 'project' | 'run';
  };
  requiresRiskAcceptance: boolean;
}

export function resolveExecutionPolicy(
  global: GlobalExecutionPreferences,
  project: ProjectExecutionPolicyOverride,
  run: RunExecutionPolicyOverride = {},
): ResolvedExecutionPolicy {
  const sourceOf = <K extends keyof RunExecutionPolicyOverride>(key: K): 'global' | 'project' | 'run' => {
    if (run[key] !== undefined) return 'run';
    if (project[key] !== undefined) return 'project';
    return 'global';
  };
  const sandboxSource = sourceOf('sandboxMode');
  const objectiveSource = sourceOf('objective');
  const autoPushSource = sourceOf('autoPush');
  const managerMergeSource = sourceOf('managerMerge');
  const sandboxMode = run.sandboxMode ?? project.sandboxMode ?? global.sandboxMode;
  const riskAcceptedAt =
    sandboxSource === 'run'
      ? run.riskAcceptedAt
      : sandboxSource === 'project'
        ? project.riskAcceptedAt
        : global.riskAcceptedAt;
  const riskAcceptedBy =
    sandboxSource === 'run'
      ? run.riskAcceptedBy
      : sandboxSource === 'project'
        ? project.riskAcceptedBy
        : global.riskAcceptedBy;

  return {
    policy: {
      projectId: project.projectId,
      sandboxMode,
      objective: run.objective ?? project.objective ?? global.objective,
      autoPush: run.autoPush ?? project.autoPush ?? global.autoPush,
      managerMerge: run.managerMerge ?? project.managerMerge ?? global.managerMerge,
      riskAcceptedAt,
      riskAcceptedBy,
    },
    sources: {
      sandboxMode: sandboxSource,
      objective: objectiveSource,
      autoPush: autoPushSource,
      managerMerge: managerMergeSource,
    },
    requiresRiskAcceptance: sandboxMode === 'danger-full-access' && !riskAcceptedAt,
  };
}

export interface ApprovalFingerprint {
  planHash: string;
  policyHash: string;
  baseRevision: string;
  worktreePath: string;
  targetRef: string;
  capabilities: readonly string[];
}

export interface ApprovalGrant extends ApprovalFingerprint {
  id: string;
  approvedBy: string;
  approvedAt: string;
  status: 'active' | 'revoked';
}

export function createApprovalGrant(
  input: Omit<ApprovalGrant, 'status'>,
): ApprovalGrant {
  return { ...input, status: 'active' };
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join('\u0000') === [...new Set(right)].sort().join('\u0000');
}

export function validateApprovalGrant(
  grant: ApprovalGrant,
  current: ApprovalFingerprint,
): { ok: true } | { ok: false; reason: string } {
  if (grant.status !== 'active') return { ok: false, reason: '批准授权已撤销' };
  if (grant.planHash !== current.planHash) return { ok: false, reason: '计划 hash 已变化' };
  if (grant.policyHash !== current.policyHash) return { ok: false, reason: '策略 hash 已变化' };
  if (grant.baseRevision !== current.baseRevision) return { ok: false, reason: '基线 revision 已变化' };
  if (grant.worktreePath !== current.worktreePath) return { ok: false, reason: 'worktree 已变化' };
  if (grant.targetRef !== current.targetRef) return { ok: false, reason: '目标 ref 已变化' };
  if (!sameCapabilities(grant.capabilities, current.capabilities)) {
    return { ok: false, reason: '允许的 capability 已变化' };
  }
  return { ok: true };
}

export function approvePlanAndEnqueueRun(input: {
  grant: ApprovalGrant;
  current: ApprovalFingerprint;
  streamId: string;
  runId: string;
  sequence: number;
  projectVersion: number;
  now: string;
}): DomainEvent[] {
  const validation = validateApprovalGrant(input.grant, input.current);
  if (!validation.ok) throw new Error(`不能批准计划：${validation.reason}`);

  return [
    {
      eventId: `${input.grant.id}:approved`,
      streamId: input.streamId,
      sequence: input.sequence,
      aggregateType: 'Project',
      aggregateId: input.streamId,
      aggregateVersion: input.projectVersion + 1,
      eventType: 'PlanApproved',
      schemaVersion: 1,
      payload: {
        grantId: input.grant.id,
        planHash: input.grant.planHash,
        policyHash: input.grant.policyHash,
      },
      actor: 'user',
      occurredAt: input.now,
    },
    {
      eventId: `${input.grant.id}:run:${input.runId}`,
      streamId: input.streamId,
      sequence: input.sequence + 1,
      aggregateType: 'Run',
      aggregateId: input.runId,
      aggregateVersion: 1,
      eventType: 'RunCreated',
      schemaVersion: 1,
      payload: {
        grantId: input.grant.id,
        runId: input.runId,
      },
      actor: 'runtime',
      occurredAt: input.now,
      causationId: input.grant.id,
    },
  ];
}

export interface WorkerCapabilityRequest {
  kind: WorkerKind;
  projectRoot: string;
  worktreePath: string;
  sandboxMode: SandboxMode;
  canWrite: boolean;
  tools: readonly string[];
}

export function validateWorkerCapability(
  request: WorkerCapabilityRequest,
): { ok: true } | { ok: false; reason: string } {
  const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (!request.projectRoot.trim() || !request.worktreePath.trim()) {
    return { ok: false, reason: 'projectRoot 和 worktreePath 不能为空' };
  }

  if (request.kind === 'planner') {
    if (request.canWrite) return { ok: false, reason: 'Planner 不允许写入' };
    if (request.tools.some((tool) => /write|patch|delete|push|merge/i.test(tool))) {
      return { ok: false, reason: 'Planner 不允许写入或外部副作用工具' };
    }
    return { ok: true };
  }

  if (!request.canWrite) return { ok: false, reason: 'Worker 必须声明写入能力' };
  if (normalizePath(request.projectRoot) === normalizePath(request.worktreePath)) {
    return { ok: false, reason: 'Worker 不能直接写项目根目录' };
  }
  if (request.sandboxMode !== 'workspace-write' && request.sandboxMode !== 'danger-full-access') {
    return { ok: false, reason: 'Worker sandbox 模式无效' };
  }
  return { ok: true };
}

export type SideEffectStatus = 'planned' | 'started' | 'receipt' | 'unknown';
export type SideEffectRecovery = 'retry' | 'skip' | 'needs-user';

export interface SideEffectReceipt {
  receiptId: string;
  observedAt: string;
  outputHash?: string;
  outcome?: 'succeeded' | 'failed';
  evidenceIds?: string[];
  acceptanceId?: string;
  artifactCandidateId?: string;
  approvalId?: string;
  files?: Array<{ path: string; contentHash: string }>;
  error?: string;
}

export interface SideEffectRecord {
  idempotencyKey: string;
  kind: string;
  target: string;
  inputHash: string;
  /** 可选执行上下文；旧账本记录没有这些字段仍可解析。 */
  runId?: string;
  taskId?: string;
  taskExecutionId?: TaskExecutionId;
  attemptId?: AttemptId;
  status: SideEffectStatus;
  recovery: SideEffectRecovery;
  receipt?: SideEffectReceipt;
  unknownReason?: string;
}

export function createSideEffect(input: Omit<SideEffectRecord, 'status' | 'recovery' | 'receipt' | 'unknownReason'>): SideEffectRecord {
  if (input.taskExecutionId !== undefined || input.attemptId !== undefined) {
    assertTaskExecutionLineage({
      runId: input.runId ?? '',
      taskId: input.taskId ?? '',
      taskExecutionId: input.taskExecutionId,
      attemptId: input.attemptId,
    });
  }
  return { ...input, status: 'planned', recovery: 'retry' };
}

export function startSideEffect(record: SideEffectRecord): SideEffectRecord {
  if (record.status !== 'planned') throw new Error('只有 planned 副作用可以启动');
  return { ...record, status: 'started', recovery: 'retry' };
}

export function completeSideEffect(record: SideEffectRecord, receipt: SideEffectReceipt): SideEffectRecord {
  if (record.status !== 'started') throw new Error('只有 started 副作用可以完成');
  return { ...record, status: 'receipt', recovery: 'skip', receipt, unknownReason: undefined };
}

export function markSideEffectUnknown(record: SideEffectRecord, reason: string): SideEffectRecord {
  if (record.status !== 'started') throw new Error('只有 started 副作用可以标记 unknown');
  return { ...record, status: 'unknown', recovery: 'needs-user', unknownReason: reason, receipt: undefined };
}
