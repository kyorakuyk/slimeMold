import type {
  DomainActor,
  DomainEvent,
  RunProjectionStatus,
  TaskProjectionStatus,
} from '../domain/contracts';
import type { EventStoreAdapter, EventStoreLock } from '../domain/eventStore';
import {
  assertTaskExecutionId,
  assertTaskExecutionLineage,
  createTaskExecutionId,
  parseAttemptId,
} from '../domain/execution';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import {
  assertTaskAttemptInvariant,
  canonicalPath,
  canonicalRef,
  canonicalRevision,
  canonicalTimestamp,
} from './workerRecoveryFactsRules';
import {
  hasWorkerSuccessProvenance,
  normalizeWorkerSuccessProvenance,
  workerRunSuccessIsValid,
} from '../domain/workerSuccess';

export const WORKER_RECOVERY_DECISION_RELATIVE_PATH = '.slimemold/runs/recovery-decisions.json';
export const WORKER_RECOVERY_DECISION_LOCK_RELATIVE_PATH = '.slimemold/runs/recovery-decisions.json.lock';

export type WorkerRecoveryDecisionAction = 'retry' | 'skip' | 'inspect';
type WorkerRecoveryDecisionStatus = 'admitted' | 'committed';
export type WorkerRecoveryDecisionPostCommitStatus = 'not-required' | 'pending' | 'dispatching' | 'completed' | 'failed';

export interface WorkerRecoveryDecisionCandidate {
  taskGraphTaskIds: string[];
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

export interface WorkerRecoveryDecisionInput {
  projectId: string;
  runId: string;
  requestIdentity: string;
  action: WorkerRecoveryDecisionAction;
  semanticPayloadVersion: 1;
  decisionId: string;
  factsFingerprint: string;
  candidate: WorkerRecoveryDecisionCandidate;
  now: string;
}

export interface WorkerRecoveryDecisionRecord {
  schemaVersion: 1;
  projectId: string;
  runId: string;
  requestIdentity: string;
  action: WorkerRecoveryDecisionAction;
  semanticPayloadVersion: 1;
  decisionId: string;
  factsFingerprint: string;
  status: WorkerRecoveryDecisionStatus;
  postCommitStatus: WorkerRecoveryDecisionPostCommitStatus;
  candidate: WorkerRecoveryDecisionCandidate;
  admittedAt: string;
  committedAt?: string;
}

export interface WorkerRecoveryDecisionReadOptions {
  readCurrentFactsFingerprint: () => Promise<string | undefined>;
  isCandidateApplied?: (candidate: WorkerRecoveryDecisionCandidate) => Promise<boolean>;
  isCandidateRepairable?: (candidate: WorkerRecoveryDecisionCandidate) => Promise<boolean>;
  isProjectionMissing?: () => Promise<boolean>;
}

export interface WorkerRecoveryDecisionAdmission {
  kind: 'admitted' | 'resume' | 'replay';
  record: WorkerRecoveryDecisionRecord;
}

export interface WorkerRecoveryDecisionCommitOptions {
  verifyProjection?: () => Promise<boolean>;
}

export type WorkerRecoveryDecisionCasErrorCode = 'stale' | 'conflict' | 'needs-repair';

export class WorkerRecoveryDecisionCasError extends Error {
  constructor(
    public readonly code: WorkerRecoveryDecisionCasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerRecoveryDecisionCasError';
  }
}

interface DecisionJournal {
  schemaVersion: 1;
  entries: WorkerRecoveryDecisionRecord[];
}

interface ParsedDecisionJournal {
  status: 'empty' | 'ok' | 'needs-repair';
  journal: DecisionJournal;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 无效`);
  return value.trim();
}

function requiredCanonicalText(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (text !== value) throw new Error(`${field} 必须是 canonical text`);
  return text;
}

function requiredIsoText(value: unknown, field: string): string {
  const text = requiredText(value, field);
  try {
    return canonicalTimestamp(text, field);
  } catch {
    throw new Error(`${field} 不是 canonical timestamp`);
  }
}

function requiredFactsFingerprint(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^worker-recovery-facts-v1:sha256:[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${field} 不是 canonical recovery facts fingerprint`);
  }
  return text;
}

function cloneCandidate(candidate: WorkerRecoveryDecisionCandidate): WorkerRecoveryDecisionCandidate {
  return JSON.parse(JSON.stringify(candidate)) as WorkerRecoveryDecisionCandidate;
}

const RUN_STATUSES: ReadonlySet<RunProjectionStatus> = new Set([
  'queued',
  'running',
  'partial',
  'blocked',
  'failed',
  'cancelled',
  'succeeded',
]);

const TASK_STATUSES: ReadonlySet<TaskProjectionStatus> = new Set([
  'queued',
  'running',
  'waiting-feedback',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);

const WORKTREE_STATUSES = new Set(['created', 'cleaned', 'orphaned', 'registration-pending']);

function requiredSafeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} 无效`);
  }
  return value as number;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, field);
}

function validateTask(value: unknown, taskIdKey: string, runId: string): void {
  if (!isRecord(value)) throw new Error(`decision candidate task 必须是对象：${taskIdKey}`);
  const taskId = requiredText(value.taskId, `decision candidate taskId：${taskIdKey}`);
  if (taskId !== taskIdKey) throw new Error(`decision candidate taskId 与 tasks key 不一致：${taskIdKey}`);
  if (!TASK_STATUSES.has(value.status as TaskProjectionStatus)) {
    throw new Error(`decision candidate task status 无效：${taskId}`);
  }
  const status = value.status as TaskProjectionStatus;
  const attempt = requiredSafeInteger(value.attempt, `decision candidate attempt：${taskId}`);
  assertTaskAttemptInvariant(status, attempt, `decision candidate task：${taskId}`);
  const pendingAttempt = value.pendingAttempt === undefined
    ? undefined
    : requiredSafeInteger(value.pendingAttempt, `decision candidate pendingAttempt：${taskId}`, 1);
  if (pendingAttempt !== undefined
    && (status !== 'queued' || pendingAttempt !== attempt + 1 || value.currentAttemptId !== undefined)) {
    throw new Error(`decision candidate pendingAttempt fence 无效：${taskId}`);
  }
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`decision candidate evidenceIds 无效：${taskId}`);
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    throw new Error(`decision candidate evidenceIds 重复：${taskId}`);
  }
  requiredIsoText(value.updatedAt, `decision candidate updatedAt：${taskId}`);
  if (value.taskDefinitionVersion !== 1) {
    throw new Error(`decision candidate taskDefinitionVersion 无效：${taskId}`);
  }
  if (value.contextPackVersion !== undefined) {
    requiredSafeInteger(value.contextPackVersion, `decision candidate contextPackVersion：${taskId}`, 1);
  }
  const taskExecutionId = optionalText(value.taskExecutionId, `decision candidate taskExecutionId：${taskId}`);
  if (taskExecutionId === undefined) {
    throw new Error(`decision candidate task 缺少 taskExecutionId：${taskId}`);
  }
  assertTaskExecutionId(taskExecutionId);
  if (taskExecutionId !== createTaskExecutionId(runId, taskId)) {
    throw new Error(`decision candidate taskExecutionId 与 runId/taskId 不一致：${taskId}`);
  }
  if (attempt > 0 && status !== 'queued' && (taskExecutionId === undefined || value.currentAttemptId === undefined)) {
    throw new Error(`decision candidate attempt 缺少 current attempt lineage：${taskId}`);
  }
  if (value.currentAttemptId !== undefined) {
    if (status === 'queued') throw new Error(`queued decision candidate 不能携带 currentAttemptId：${taskId}`);
    const executionId = taskExecutionId ?? createTaskExecutionId(runId, taskId);
    const currentAttemptId = requiredText(value.currentAttemptId, `decision candidate currentAttemptId：${taskId}`);
    assertTaskExecutionLineage({
      runId,
      taskId,
      taskExecutionId: executionId,
      attemptId: currentAttemptId,
      attempt,
    });
    const parsed = parseAttemptId(currentAttemptId);
    if (parsed.taskExecutionId !== executionId || parsed.attempt !== attempt || attempt < 1) {
      throw new Error(`decision candidate currentAttemptId 与 task lineage 不一致：${taskId}`);
    }
  }
  const assignmentFields = [value.worktreeId, value.worktreePath, value.branch, value.baseRevision];
  const assignmentCount = assignmentFields.filter((fieldValue) => fieldValue !== undefined).length;
  if (assignmentCount !== 0 && assignmentCount !== assignmentFields.length) {
    throw new Error(`decision candidate WorkerTask assignment 不完整：${taskId}`);
  }
  for (const [field, fieldValue] of [
    ['worktreeId', value.worktreeId],
    ['worktreePath', value.worktreePath],
    ['branch', value.branch],
    ['baseRevision', value.baseRevision],
    ['targetIdentity', value.targetIdentity],
    ['branchRevision', value.branchRevision],
    ['cleanupStateSignature', value.cleanupStateSignature],
    ['feedbackId', value.feedbackId],
    ['acceptanceId', value.acceptanceId],
    ['cleanupReceiptId', value.cleanupReceiptId],
    ['error', value.error],
  ] as const) {
    optionalText(fieldValue, `decision candidate ${field}：${taskId}`);
  }
  if (value.worktreePath !== undefined) canonicalPath(value.worktreePath as string, `decision candidate worktreePath：${taskId}`);
  if (value.branch !== undefined) canonicalRef(value.branch as string, `decision candidate branch：${taskId}`);
  if (value.baseRevision !== undefined) canonicalRevision(value.baseRevision as string, `decision candidate baseRevision：${taskId}`);
  if (value.branchRevision !== undefined) canonicalRevision(value.branchRevision as string, `decision candidate branchRevision：${taskId}`);
  if (value.worktreeStatus !== undefined && !WORKTREE_STATUSES.has(value.worktreeStatus as string)) {
    throw new Error(`decision candidate worktreeStatus 无效：${taskId}`);
  }
  if (['created', 'orphaned', 'registration-pending'].includes(value.worktreeStatus as string)
    && (assignmentCount !== assignmentFields.length || value.branchRevision === undefined)) {
    throw new Error(`decision candidate assigned worktree 缺少 provenance：${taskId}`);
  }
  if (value.cleanupStatus !== undefined && value.cleanupStatus !== 'cleaned') {
    throw new Error(`decision candidate cleanupStatus 无效：${taskId}`);
  }
  if (value.cleanupStatus === 'cleaned'
    && (status !== 'succeeded' || value.worktreeStatus !== 'cleaned' || value.cleanupReceiptId === undefined)) {
    throw new Error(`decision candidate cleanup provenance 无效：${taskId}`);
  }
  if (value.worktreeStatus === 'cleaned'
    && (value.cleanupStatus !== 'cleaned' || value.cleanupReceiptId === undefined)) {
    throw new Error(`decision candidate cleaned worktree 缺少 receipt：${taskId}`);
  }
  if (status === 'succeeded') normalizeWorkerSuccessProvenance(value.evidenceIds, value.acceptanceId);
  if (status === 'waiting-feedback' && value.feedbackId === undefined) {
    throw new Error(`decision candidate waiting-feedback 缺少 feedbackId：${taskId}`);
  }
  if (status !== 'waiting-feedback' && value.feedbackId !== undefined) {
    throw new Error(`非 waiting-feedback decision candidate 不能携带 feedbackId：${taskId}`);
  }
}

function validateState(value: unknown, context: { projectId: string; runId: string }): WorkerRunQueueState {
  if (!isRecord(value)) throw new Error('decision candidate.state 必须是对象');
  if (value.version !== 1) throw new Error('decision candidate.state.version 无效');
  const projectId = requiredCanonicalText(value.projectId, 'decision candidate.state.projectId');
  if (projectId !== context.projectId) throw new Error('decision candidate.state.projectId 与 record 不一致');
  const runId = requiredCanonicalText(value.runId, 'decision candidate.state.runId');
  if (runId !== context.runId) throw new Error('decision candidate.state.runId 与 record 不一致');
  requiredCanonicalText(value.taskGraphId, 'decision candidate.state.taskGraphId');
  requiredSafeInteger(value.taskGraphVersion, 'decision candidate.state.taskGraphVersion', 1);
  if (!RUN_STATUSES.has(value.status as RunProjectionStatus)) {
    throw new Error('decision candidate.state.status 无效');
  }
  requiredIsoText(value.createdAt, 'decision candidate.state.createdAt');
  requiredIsoText(value.updatedAt, 'decision candidate.state.updatedAt');
  if (!isRecord(value.tasks)) throw new Error('decision candidate.state.tasks 必须是对象');
  for (const [taskId, task] of Object.entries(value.tasks)) validateTask(task, taskId, runId);
  optionalText(value.orchestrationId, 'decision candidate.state.orchestrationId');
  return value as unknown as WorkerRunQueueState;
}

function validateActor(value: unknown): asserts value is DomainActor {
  if (value === 'user' || value === 'master' || value === 'runtime' || value === 'system') return;
  if (typeof value === 'string' && value.startsWith('plugin:') && value.length > 'plugin:'.length) return;
  throw new Error('decision event actor 无效');
}

const RECOVERY_EVENT_TYPES = new Set([
  'WorkerRunRecoveryDecided',
  'RunQueued',
  'RunPartial',
  'TaskAttemptMarkedUnknown',
  'TaskQueued',
  'TaskFailed',
  'TaskBlocked',
]);

function validateEvent(
  value: unknown,
  context: {
    projectId: string;
    runId: string;
    decisionId: string;
    action: WorkerRecoveryDecisionAction;
    taskGraphId: string;
    taskGraphVersion: number;
    taskGraphTaskIds: ReadonlySet<string>;
  },
): DomainEvent {
  if (!isRecord(value)) throw new Error('decision candidate event 必须是对象');
  const eventId = requiredCanonicalText(value.eventId, 'decision eventId');
  if (!eventId.startsWith(`${context.decisionId}:`)) throw new Error('decision eventId 与 decisionId 不一致');
  if (requiredCanonicalText(value.streamId, 'decision streamId') !== context.projectId) {
    throw new Error('decision event streamId 与 projectId 不一致');
  }
  const sequence = requiredSafeInteger(value.sequence, 'decision event sequence', 1);
  requiredCanonicalText(value.aggregateType, 'decision aggregateType');
  const aggregateType = value.aggregateType as string;
  const aggregateId = requiredCanonicalText(value.aggregateId, 'decision aggregateId');
  requiredSafeInteger(value.aggregateVersion, 'decision aggregateVersion', 1);
  const eventType = requiredCanonicalText(value.eventType, 'decision eventType');
  if (!RECOVERY_EVENT_TYPES.has(eventType)) throw new Error(`decision eventType 不允许：${eventType}`);
  if (value.schemaVersion !== 1) throw new Error('decision event schemaVersion 无效');
  if (!isRecord(value.payload)) throw new Error('decision event payload 必须是对象');
  if (requiredCanonicalText(value.payload.runId, 'decision event payload.runId') !== context.runId) {
    throw new Error('decision event payload.runId 与 record 不一致');
  }
  if (value.payload.recoveryDecisionId !== undefined && value.payload.recoveryDecisionId !== context.decisionId) {
    throw new Error('decision event recoveryDecisionId 与 decisionId 不一致');
  }
  if (aggregateType === 'Run') {
    if (aggregateId !== context.runId) throw new Error('decision Run aggregateId 与 runId 不一致');
  } else if (aggregateType === 'TaskExecution') {
    assertTaskExecutionId(aggregateId);
    const taskId = requiredCanonicalText(value.payload.taskId, 'decision task event payload.taskId');
    if (!context.taskGraphTaskIds.has(taskId)) throw new Error(`decision event taskId 不属于 task graph：${taskId}`);
    const taskExecutionId = requiredCanonicalText(value.payload.taskExecutionId, 'decision task event payload.taskExecutionId');
    assertTaskExecutionId(taskExecutionId);
    if (value.payload.attemptId !== undefined) {
      assertTaskExecutionLineage({
        runId: context.runId,
        taskId,
        taskExecutionId,
        attemptId: requiredCanonicalText(value.payload.attemptId, 'decision event attemptId'),
        ...(value.payload.attempt !== undefined ? { attempt: requiredSafeInteger(value.payload.attempt, 'decision event attempt', 0) } : {}),
      });
    }
    if (taskExecutionId !== aggregateId) throw new Error('decision task event aggregateId 与 taskExecutionId 不一致');
  } else {
    throw new Error(`decision aggregateType 不允许：${aggregateType}`);
  }
  validateActor(value.actor);
  requiredIsoText(value.occurredAt, 'decision event occurredAt');
  if (requiredCanonicalText(value.correlationId, 'decision event correlationId') !== context.runId) {
    throw new Error('decision event correlationId 与 runId 不一致');
  }
  if (!isRecord(value.source)) throw new Error('decision event source 必须是对象');
  if (requiredCanonicalText(value.source.objectId, 'decision event source.objectId') !== context.taskGraphId) {
    throw new Error('decision event source.objectId 与 taskGraphId 不一致');
  }
  if (requiredSafeInteger(value.source.objectVersion, 'decision event source.objectVersion', 1) !== context.taskGraphVersion) {
    throw new Error('decision event source.objectVersion 与 taskGraphVersion 不一致');
  }
  if (value.sensitivity !== undefined && value.sensitivity !== 'normal' && value.sensitivity !== 'private') {
    throw new Error('decision event sensitivity 无效');
  }
  if (value.synthetic !== undefined && typeof value.synthetic !== 'boolean') {
    throw new Error('decision event synthetic 无效');
  }
  if (context.action !== 'inspect' && eventType === 'WorkerRunRecoveryDecided' && sequence !== 1) {
    throw new Error('mutating recovery decision 必须以 WorkerRunRecoveryDecided 开始');
  }
  if (eventType === 'WorkerRunRecoveryDecided') {
    const decision = requiredText(value.payload.decision, 'decision recovery event decision');
    if (decision !== context.action) {
      throw new Error('decision recovery event decision 与 action 不一致');
    }
    if (typeof value.payload.requiresNewAttempt !== 'boolean'
      || value.payload.requiresNewAttempt !== (context.action === 'retry')) {
      throw new Error('decision recovery event requiresNewAttempt 与 action 不一致');
    }
    if (value.payload.taskIds !== undefined) {
      if (!Array.isArray(value.payload.taskIds)
        || value.payload.taskIds.some((taskId) => typeof taskId !== 'string' || !taskId.trim())
        || new Set(value.payload.taskIds).size !== value.payload.taskIds.length
        || value.payload.taskIds.some((taskId) => !context.taskGraphTaskIds.has(taskId))) {
        throw new Error('decision recovery event taskIds 无效');
      }
    }
  }
  if (context.action === 'retry' && (eventType === 'TaskFailed' || eventType === 'TaskBlocked')) {
    throw new Error(`retry recovery 不能产生 ${eventType} event`);
  }
  if (context.action === 'skip' && (eventType === 'TaskAttemptMarkedUnknown' || eventType === 'TaskQueued')) {
    throw new Error(`skip recovery 不能产生 ${eventType} event`);
  }
  return value as unknown as DomainEvent;
}

function validateCandidate(
  value: unknown,
  context: { projectId: string; runId: string; decisionId: string; action: WorkerRecoveryDecisionAction },
): WorkerRecoveryDecisionCandidate {
  if (!isRecord(value)) throw new Error('decision candidate 必须是对象');
  if (!Array.isArray(value.taskGraphTaskIds)
    || value.taskGraphTaskIds.some((taskId) => typeof taskId !== 'string' || !taskId.trim())
    || new Set(value.taskGraphTaskIds).size !== value.taskGraphTaskIds.length) {
    throw new Error('decision candidate.taskGraphTaskIds 无效');
  }
  if (!Array.isArray(value.events)) throw new Error('decision candidate.events 必须是数组');
  if (context.action !== 'inspect' && value.events.length === 0) {
    throw new Error('mutating recovery decision 不能没有事件');
  }
  const state = validateState(value.state, context);
  const stateTaskIds = Object.keys(state.tasks).sort();
  const graphTaskIds = [...value.taskGraphTaskIds].sort();
  if (JSON.stringify(stateTaskIds) !== JSON.stringify(graphTaskIds)) {
    throw new Error('decision candidate task set 与 task graph 不一致');
  }
  const eventContext = {
    ...context,
    taskGraphId: state.taskGraphId,
    taskGraphVersion: state.taskGraphVersion,
    taskGraphTaskIds: new Set(value.taskGraphTaskIds),
  };
  const events = value.events.map((event) => validateEvent(event, eventContext));
  if (context.action !== 'inspect') {
    const decisionEvent = events[0];
    if (!decisionEvent || decisionEvent.eventType !== 'WorkerRunRecoveryDecided') {
      throw new Error('mutating recovery decision 必须以 WorkerRunRecoveryDecided 开始');
    }
    const decisionPayload = decisionEvent.payload as Record<string, unknown>;
    const decisionTaskIds = decisionPayload.taskIds;
    if (!Array.isArray(decisionTaskIds)
      || decisionTaskIds.some((taskId) => typeof taskId !== 'string' || taskId.trim() !== taskId || !taskId)
      || new Set(decisionTaskIds).size !== decisionTaskIds.length) {
      throw new Error('decision recovery event 必须携带 canonical taskIds');
    }
    const eventTaskIds = [...new Set(events
      .filter((event) => event.aggregateType === 'TaskExecution')
      .map((event) => String((event.payload as Record<string, unknown>).taskId)))].sort();
    if (JSON.stringify([...decisionTaskIds].sort()) !== JSON.stringify(eventTaskIds)) {
      throw new Error('decision recovery event taskIds 与 task event set 不一致');
    }
    if (context.action === 'retry') {
      if (events.some((event) => event.eventType === 'RunPartial'
        || event.eventType === 'TaskFailed'
        || event.eventType === 'TaskBlocked')
        || !events.some((event) => event.eventType === 'TaskQueued')) {
        throw new Error('retry recovery event set 无效');
      }
    } else if (events.some((event) => event.eventType === 'RunQueued'
      || event.eventType === 'TaskAttemptMarkedUnknown'
      || event.eventType === 'TaskQueued')
      || !events.some((event) => event.eventType === 'TaskFailed' || event.eventType === 'TaskBlocked')) {
      throw new Error('skip recovery event set 无效');
    }
  }
  const tasks = Object.values(state.tasks);
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  const aggregateVersions = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (eventIds.has(event.eventId)) throw new Error(`decision eventId 重复：${event.eventId}`);
    if (sequences.has(event.sequence)) throw new Error(`decision event sequence 重复：${event.sequence}`);
    if (event.sequence !== index + 1) throw new Error('decision event sequence 必须从 1 连续递增');
    const aggregateKey = `${event.aggregateType}:${event.aggregateId}`;
    const previousVersion = aggregateVersions.get(aggregateKey) ?? 0;
    if (event.aggregateVersion !== previousVersion + 1) {
      throw new Error(`decision aggregateVersion 不连续：${aggregateKey}`);
    }
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
    aggregateVersions.set(aggregateKey, event.aggregateVersion);
  }
  for (const task of tasks) {
    if (task.status === 'succeeded' && !hasWorkerSuccessProvenance(task)) {
      throw new Error(`succeeded Worker Task 缺少 success provenance：${task.taskId}`);
    }
  }
  if (state.status === 'succeeded' && !workerRunSuccessIsValid(tasks)) {
    throw new Error('succeeded Worker Run 缺少完整 success provenance');
  }
  return {
    taskGraphTaskIds: [...value.taskGraphTaskIds],
    state,
    events,
  };
}

function validateRecord(value: unknown): WorkerRecoveryDecisionRecord {
  if (!isRecord(value)) throw new Error('recovery decision record 必须是对象');
  if (value.schemaVersion !== 1) throw new Error('recovery decision schemaVersion 无效');
  const action = value.action;
  if (action !== 'retry' && action !== 'skip' && action !== 'inspect') {
    throw new Error('recovery decision action 无效');
  }
  if (value.semanticPayloadVersion !== 1) throw new Error('recovery decision semanticPayloadVersion 无效');
  const status = value.status;
  if (status !== 'admitted' && status !== 'committed') throw new Error('recovery decision status 无效');
  const postCommitStatus = value.postCommitStatus === undefined
    ? (status === 'committed' ? (action === 'retry' ? 'pending' : 'completed') : 'not-required')
    : value.postCommitStatus;
  if (postCommitStatus !== 'not-required'
    && postCommitStatus !== 'pending'
    && postCommitStatus !== 'dispatching'
    && postCommitStatus !== 'completed'
    && postCommitStatus !== 'failed') {
    throw new Error('recovery decision postCommitStatus 无效');
  }
  if (status === 'admitted' && postCommitStatus !== 'not-required') {
    throw new Error('admitted decision 不能包含 postCommitStatus');
  }
  if (status === 'committed' && action === 'retry' && postCommitStatus === 'not-required') {
    throw new Error('retry committed decision 缺少 postCommitStatus');
  }
  if (status === 'committed' && action !== 'retry' && postCommitStatus !== 'completed') {
    throw new Error('non-retry committed decision 必须完成 post-commit');
  }
  const committedAt = value.committedAt === undefined
    ? undefined
    : requiredIsoText(value.committedAt, 'recovery decision committedAt');
  if (status === 'committed' && !committedAt) throw new Error('committed decision 缺少 committedAt');
  const projectId = requiredCanonicalText(value.projectId, 'recovery decision projectId');
  const runId = requiredCanonicalText(value.runId, 'recovery decision runId');
  const decisionId = requiredCanonicalText(value.decisionId, 'recovery decision decisionId');
  return {
    schemaVersion: 1,
    projectId,
    runId,
    requestIdentity: requiredCanonicalText(value.requestIdentity, 'recovery decision requestIdentity'),
    action,
    semanticPayloadVersion: 1,
    decisionId,
    factsFingerprint: requiredFactsFingerprint(value.factsFingerprint, 'recovery decision factsFingerprint'),
    status,
    postCommitStatus,
    candidate: validateCandidate(value.candidate, { projectId, runId, decisionId, action }),
    admittedAt: requiredIsoText(value.admittedAt, 'recovery decision admittedAt'),
    ...(committedAt ? { committedAt } : {}),
  };
}

function validateDecisionInput(input: WorkerRecoveryDecisionInput): void {
  const projectId = requiredCanonicalText(input.projectId, 'recovery decision projectId');
  const runId = requiredCanonicalText(input.runId, 'recovery decision runId');
  const decisionId = requiredCanonicalText(input.decisionId, 'recovery decision decisionId');
  requiredCanonicalText(input.requestIdentity, 'recovery decision requestIdentity');
  if (input.action !== 'retry' && input.action !== 'skip' && input.action !== 'inspect') {
    throw new Error('recovery decision action 无效');
  }
  if (input.semanticPayloadVersion !== 1) throw new Error('recovery decision semanticPayloadVersion 无效');
  requiredFactsFingerprint(input.factsFingerprint, 'recovery decision factsFingerprint');
  requiredIsoText(input.now, 'recovery decision now');
  validateCandidate(input.candidate, { projectId, runId, decisionId, action: input.action });
}

function parseJournal(text: string | null | undefined): ParsedDecisionJournal {
  if (!text || !text.trim()) return { status: 'empty', journal: { schemaVersion: 1, entries: [] } };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error('recovery decision journal schema 无效');
    }
    const entries: WorkerRecoveryDecisionRecord[] = [];
    for (const item of value.entries) {
      const record = validateRecord(item);
      if (entries.some((existing) => existing.requestIdentity === record.requestIdentity)) {
        throw new Error(`recovery decision requestIdentity 重复：${record.requestIdentity}`);
      }
      entries.push(record);
    }
    return { status: 'ok', journal: { schemaVersion: 1, entries } };
  } catch (error) {
    return {
      status: 'needs-repair',
      journal: { schemaVersion: 1, entries: [] },
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function serializeJournal(journal: DecisionJournal): string {
  return JSON.stringify(journal);
}

function sameIdentity(record: WorkerRecoveryDecisionRecord, input: WorkerRecoveryDecisionInput): boolean {
  return record.projectId === input.projectId
    && record.runId === input.runId
    && record.requestIdentity === input.requestIdentity
    && record.action === input.action
    && record.semanticPayloadVersion === input.semanticPayloadVersion
    && record.decisionId === input.decisionId
    && record.factsFingerprint === input.factsFingerprint
    && JSON.stringify(record.candidate) === JSON.stringify(input.candidate);
}

export class WorkerRecoveryDecisionPersistence {
  public readonly path: string;
  private readonly lockPath: string;

  constructor(
    private readonly adapter: EventStoreAdapter,
    root: string,
  ) {
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    this.path = `${normalizedRoot}/${WORKER_RECOVERY_DECISION_RELATIVE_PATH}`;
    this.lockPath = `${normalizedRoot}/${WORKER_RECOVERY_DECISION_LOCK_RELATIVE_PATH}`;
  }

  async read(): Promise<ParsedDecisionJournal> {
    return parseJournal(await this.adapter.readText(this.path));
  }

  async find(requestIdentity: string): Promise<WorkerRecoveryDecisionRecord | undefined> {
    const parsed = await this.read();
    if (parsed.status === 'needs-repair') {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
      );
    }
    return parsed.journal.entries.find((record) => record.requestIdentity === requestIdentity);
  }

  async withDecisionLock<T>(operation: (lock: EventStoreLock) => Promise<T>): Promise<T> {
    const lock = await this.adapter.acquireLock(this.lockPath);
    try {
      return await operation(lock);
    } finally {
      await lock.release();
    }
  }

  private async persistAndReadBack(journal: DecisionJournal): Promise<DecisionJournal> {
    const serialized = serializeJournal(journal);
    await this.adapter.writeTextAtomic(this.path, serialized);
    const parsed = parseJournal(await this.adapter.readText(this.path));
    if (parsed.status !== 'ok' || serializeJournal(parsed.journal) !== serialized) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery decision 写入后 read-back 不一致：${this.path}${parsed.reason ? ` (${parsed.reason})` : ''}`,
      );
    }
    return parsed.journal;
  }

  async admit(
    input: WorkerRecoveryDecisionInput,
    options: WorkerRecoveryDecisionReadOptions,
    existingLock?: EventStoreLock,
  ): Promise<WorkerRecoveryDecisionAdmission> {
    validateDecisionInput(input);
    const lock = existingLock ?? await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const semanticConflict = parsed.journal.entries.find((record) => record.projectId === input.projectId
        && record.runId === input.runId
        && record.factsFingerprint === input.factsFingerprint
        && record.semanticPayloadVersion === input.semanticPayloadVersion
        && record.requestIdentity !== input.requestIdentity);
      if (semanticConflict) {
        throw new WorkerRecoveryDecisionCasError(
          'conflict',
          `recovery facts/action 已绑定其它 requestIdentity：${semanticConflict.requestIdentity}`,
        );
      }
      const existing = parsed.journal.entries.find((record) => record.requestIdentity === input.requestIdentity);
      if (existing) {
        if (!sameIdentity(existing, input)) {
          throw new WorkerRecoveryDecisionCasError(
            'conflict',
            `recovery requestIdentity 已绑定其它 decision：${input.requestIdentity}`,
          );
        }
        if (existing.status === 'committed') {
          const applied = options.isCandidateApplied
            ? await options.isCandidateApplied(existing.candidate)
            : false;
          if (applied) return { kind: 'replay', record: existing };
          const repairable = options.isCandidateRepairable
            ? await options.isCandidateRepairable(existing.candidate)
            : false;
          if (repairable || (options.isProjectionMissing && await options.isProjectionMissing())) {
            return { kind: 'resume', record: existing };
          }
          const currentFingerprint = await options.readCurrentFactsFingerprint();
          if (currentFingerprint === undefined || currentFingerprint !== existing.factsFingerprint) {
            throw new WorkerRecoveryDecisionCasError(
              'needs-repair',
              `committed recovery decision 的 candidate 与当前 facts 均不一致：${input.requestIdentity}`,
            );
          }
          return { kind: 'resume', record: existing };
        }
        const repairable = options.isCandidateRepairable
          ? await options.isCandidateRepairable(existing.candidate)
          : false;
        if (repairable || (options.isProjectionMissing && await options.isProjectionMissing())) {
          return { kind: 'resume', record: existing };
        }
        const currentFingerprint = await options.readCurrentFactsFingerprint();
        if (currentFingerprint === undefined || currentFingerprint !== existing.factsFingerprint) {
          const applied = options.isCandidateApplied
            ? await options.isCandidateApplied(existing.candidate)
            : false;
          if (!applied) {
            throw new WorkerRecoveryDecisionCasError(
              'needs-repair',
              `recovery decision 已 admitted 但当前 facts 已漂移：${input.requestIdentity}`,
            );
          }
        }
        return { kind: 'resume', record: existing };
      }

      const currentFingerprint = await options.readCurrentFactsFingerprint();
      if (currentFingerprint === undefined || currentFingerprint !== input.factsFingerprint) {
        throw new WorkerRecoveryDecisionCasError(
          'stale',
          `recovery decision facts 已过期：${input.requestIdentity}`,
        );
      }
      const record: WorkerRecoveryDecisionRecord = {
        schemaVersion: 1,
        projectId: requiredText(input.projectId, 'recovery decision projectId'),
        runId: requiredText(input.runId, 'recovery decision runId'),
        requestIdentity: requiredText(input.requestIdentity, 'recovery decision requestIdentity'),
        action: input.action,
        semanticPayloadVersion: 1,
        decisionId: requiredText(input.decisionId, 'recovery decision decisionId'),
        factsFingerprint: requiredText(input.factsFingerprint, 'recovery decision factsFingerprint'),
        status: 'admitted',
        postCommitStatus: 'not-required',
        candidate: cloneCandidate(input.candidate),
        admittedAt: requiredIsoText(input.now, 'recovery decision now'),
      };
      const journal = await this.persistAndReadBack({
        schemaVersion: 1,
        entries: [...parsed.journal.entries, record],
      });
      return {
        kind: 'admitted',
        record: journal.entries.find((item) => item.requestIdentity === input.requestIdentity) ?? record,
      };
    } finally {
      if (!existingLock) await lock.release();
    }
  }

  async commit(
    input: WorkerRecoveryDecisionInput,
    options: WorkerRecoveryDecisionCommitOptions = {},
    existingLock?: EventStoreLock,
  ): Promise<WorkerRecoveryDecisionRecord> {
    validateDecisionInput(input);
    const lock = existingLock ?? await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const index = parsed.journal.entries.findIndex((record) => record.requestIdentity === input.requestIdentity);
      if (index < 0) {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery decision 尚未 admitted：${input.requestIdentity}`);
      }
      const existing = parsed.journal.entries[index];
      if (!sameIdentity(existing, input)) {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery decision commit identity 冲突：${input.requestIdentity}`);
      }
      if (existing.status === 'committed') {
        if (options.verifyProjection && !(await options.verifyProjection())) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery projection 在 durable commit lock 内发生漂移：${input.requestIdentity}`,
          );
        }
        return existing;
      }
      if (options.verifyProjection && !(await options.verifyProjection())) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery projection 在 durable commit lock 内发生漂移：${input.requestIdentity}`,
        );
      }
      const committed: WorkerRecoveryDecisionRecord = {
        ...existing,
        status: 'committed',
        postCommitStatus: existing.action === 'retry' ? 'pending' : 'completed',
        committedAt: requiredIsoText(input.now, 'recovery decision commit time'),
      };
      const entries = [...parsed.journal.entries];
      entries[index] = committed;
      const journal = await this.persistAndReadBack({ schemaVersion: 1, entries });
      return journal.entries[index];
    } finally {
      if (!existingLock) await lock.release();
    }
  }

  async markPostCommit(
    input: WorkerRecoveryDecisionInput,
    status: Exclude<WorkerRecoveryDecisionPostCommitStatus, 'not-required'>,
    now: string,
    existingLock?: EventStoreLock,
  ): Promise<WorkerRecoveryDecisionRecord> {
    validateDecisionInput(input);
    const lock = existingLock ?? await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const index = parsed.journal.entries.findIndex((record) => record.requestIdentity === input.requestIdentity);
      if (index < 0) {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery decision 尚未 admitted：${input.requestIdentity}`);
      }
      const existing = parsed.journal.entries[index];
      if (!sameIdentity(existing, input) || existing.status !== 'committed' || existing.action !== 'retry') {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery post-commit identity 冲突：${input.requestIdentity}`);
      }
      const allowedTransition = existing.postCommitStatus === status
        || (existing.postCommitStatus === 'pending' && status === 'dispatching')
        || (existing.postCommitStatus === 'dispatching' && (status === 'completed' || status === 'failed'))
        || (existing.postCommitStatus === 'failed' && status === 'pending');
      if (!allowedTransition) {
        throw new WorkerRecoveryDecisionCasError(
          'conflict',
          `recovery post-commit 状态迁移非法：${existing.postCommitStatus} -> ${status}`,
        );
      }
      const updated: WorkerRecoveryDecisionRecord = {
        ...existing,
        postCommitStatus: status,
      };
      requiredIsoText(now, 'recovery decision post-commit time');
      const entries = [...parsed.journal.entries];
      entries[index] = updated;
      const journal = await this.persistAndReadBack({ schemaVersion: 1, entries });
      return journal.entries[index];
    } finally {
      if (!existingLock) await lock.release();
    }
  }
}
