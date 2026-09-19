import {
  createWorkerRunQueue,
  restoreWorkerRunQueue,
  type WorkerQueueTask,
  type WorkerRunQueueState,
} from '../domain/workerQueue';
import {
  replayDomainEvents,
  type DomainEvent,
} from '../domain/contracts';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { hasWorkerSuccessProvenance, workerRunSuccessIsValid } from '../domain/workerSuccess';
import type { ProjectTaskGraph } from './types';

type EventPayload = Record<string, unknown>;

export interface WorkerRunRehydrationIssue {
  runId?: string;
  taskId?: string;
  message: string;
}

export interface WorkerRunRehydrationResult {
  runs: WorkerRunQueueState[];
  issues: WorkerRunRehydrationIssue[];
}

export interface MissingWorkerRunProjectionResult extends WorkerRunRehydrationResult {
  restored: boolean;
}

export interface WorkerRunSnapshotReconciliationResult {
  runs: WorkerRunQueueState[];
  changedRunIds: string[];
  issues: WorkerRunRehydrationIssue[];
}

function payload(event: DomainEvent): EventPayload {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as EventPayload
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value as string[];
}

function runStatusFor(eventType: string): WorkerRunQueueState['status'] | undefined {
  switch (eventType) {
    case 'RunCreated': return 'queued';
    case 'RunQueued': return 'queued';
    case 'RunStarted': return 'running';
    case 'RunPartial': return 'partial';
    case 'RunSucceeded': return 'succeeded';
    case 'RunFailed': return 'failed';
    case 'RunBlocked': return 'blocked';
    case 'RunCancelled': return 'cancelled';
    default: return undefined;
  }
}

function taskStatusFor(eventType: string): WorkerQueueTask['status'] | undefined {
  switch (eventType) {
    case 'TaskQueued': return 'queued';
    case 'TaskStarted': return 'running';
    case 'TaskSucceeded': return 'succeeded';
    case 'TaskFailed': return 'failed';
    case 'TaskBlocked': return 'blocked';
    case 'TaskFeedbackRequested': return 'waiting-feedback';
    default: return undefined;
  }
}

function applyTaskEvent(
  state: WorkerRunQueueState,
  event: DomainEvent,
  issues: WorkerRunRehydrationIssue[],
): WorkerRunQueueState {
  const p = payload(event);
  const taskId = text(p.taskId) ?? (event.aggregateType === 'Task' ? event.aggregateId : undefined);
  if (!taskId) return state;
  const current = state.tasks[taskId];
  if (!current) {
    issues.push({ runId: state.runId, taskId, message: `事件引用了 TaskGraph 外的 Task：${taskId}` });
    return state;
  }
  const status = taskStatusFor(event.eventType);
  if (!status && event.eventType !== 'TaskCleaned' && event.eventType !== 'TaskAttemptMarkedUnknown') return state;
  if (event.eventType === 'TaskSucceeded'
    && !hasWorkerSuccessProvenance({ evidenceIds: stringList(p.evidenceIds), acceptanceId: text(p.acceptanceId) })) {
    issues.push({ runId: state.runId, taskId, message: `TaskSucceeded 缺少有效 Evidence/Acceptance provenance：${taskId}` });
    return state;
  }

  const taskExecutionId = text(p.taskExecutionId) ?? current.taskExecutionId ?? createTaskExecutionId(state.runId, taskId);
  const nextAttempt = event.eventType === 'TaskQueued' ? positiveInteger(p.nextAttempt) : undefined;
  const attempt = nextAttempt !== undefined ? nextAttempt - 1 : positiveInteger(p.attempt) ?? current.attempt;
  const attemptId = text(p.attemptId)
    ?? (attempt > 0 ? createAttemptId(taskExecutionId, attempt) : undefined);
  const next: WorkerQueueTask = {
    ...current,
    taskExecutionId,
    updatedAt: event.occurredAt,
  };
  if (status) next.status = status;
  if (attempt > 0) next.attempt = attempt;
  if (attemptId) next.currentAttemptId = attemptId;

  const worktreeId = text(p.worktreeId);
  const worktreePath = text(p.worktreePath);
  const branch = text(p.branch);
  const baseRevision = text(p.baseRevision);
  const worktreeStatus = text(p.worktreeStatus) as WorkerQueueTask['worktreeStatus'] | undefined;
  if (worktreeId) next.worktreeId = worktreeId;
  if (worktreePath) next.worktreePath = worktreePath;
  if (branch) next.branch = branch;
  if (baseRevision) next.baseRevision = baseRevision;
  if (worktreeStatus && ['created', 'cleaned', 'orphaned', 'registration-pending'].includes(worktreeStatus)) {
    next.worktreeStatus = worktreeStatus;
  }

  const evidenceIds = stringList(p.evidenceIds);
  const acceptanceId = text(p.acceptanceId);
  const error = text(p.error);
  const feedbackId = text(p.feedbackId);
  const receiptId = text(p.receiptId);
  if (evidenceIds) next.evidenceIds = evidenceIds;
  if (acceptanceId) next.acceptanceId = acceptanceId;
  if (error) next.error = error;
  if (feedbackId) next.feedbackId = feedbackId;
  if (event.eventType === 'TaskCleaned') {
    next.cleanupStatus = 'cleaned';
    next.worktreeStatus = 'cleaned';
    if (receiptId) next.cleanupReceiptId = receiptId;
  }
  if (event.eventType === 'TaskStarted'
    || event.eventType === 'TaskBlocked'
    || event.eventType === 'TaskSucceeded'
    || event.eventType === 'TaskFailed'
    || event.eventType === 'TaskCleaned') {
    next.pendingAttempt = undefined;
  }
  if (event.eventType === 'TaskAttemptMarkedUnknown') {
    next.status = 'running';
    next.currentAttemptId = undefined;
  }
  if (event.eventType === 'TaskQueued' && nextAttempt !== undefined) {
    next.status = 'queued';
    next.pendingAttempt = nextAttempt;
    next.currentAttemptId = undefined;
    next.worktreeId = undefined;
    next.worktreePath = undefined;
    next.branch = undefined;
    next.baseRevision = undefined;
    next.worktreeStatus = undefined;
    next.branchRevision = undefined;
    next.cleanupStateSignature = undefined;
    next.evidenceIds = [];
    next.acceptanceId = undefined;
    next.cleanupStatus = undefined;
    next.cleanupReceiptId = undefined;
    next.error = undefined;
    next.feedbackId = undefined;
  }

  return {
    ...state,
    updatedAt: event.occurredAt,
    tasks: { ...state.tasks, [taskId]: next },
  };
}

/**
 * Rebuild missing WorkerRun ProjectFile projections from the append-only event stream.
 * This is a recovery projection only: it requires an approved, version-matching TaskGraph
 * and never invents a Task, Attempt, Worktree, or status when lineage is incomplete.
 */
export function rehydrateWorkerRunsFromEvents(input: {
  projectId: string;
  events: readonly DomainEvent[];
  taskGraphs: readonly ProjectTaskGraph[];
  existingRuns?: readonly WorkerRunQueueState[];
}): WorkerRunRehydrationResult {
  const existingIds = new Set((input.existingRuns ?? []).map((run) => run.runId));
  const issues: WorkerRunRehydrationIssue[] = [];
  const runs: WorkerRunQueueState[] = [];
  const projectEvents = input.events.filter((event) => event.streamId === input.projectId);
  try {
    replayDomainEvents(projectEvents);
  } catch (cause) {
    return {
      runs,
      issues: [{ message: `Worker project 事件流生命周期校验失败：${cause instanceof Error ? cause.message : String(cause)}` }],
    };
  }
  const runCreatedEvents = projectEvents.filter((event) => (
    event.eventType === 'RunCreated'
  ));

  for (const created of runCreatedEvents) {
    const p = payload(created);
    const runId = text(p.runId) ?? (created.aggregateType === 'Run' ? created.aggregateId : undefined);
    if (!runId || existingIds.has(runId) || runs.some((run) => run.runId === runId)) continue;
    const taskGraphId = text(p.taskGraphId);
    const taskGraphVersion = positiveInteger(p.taskGraphVersion);
    const taskGraph = input.taskGraphs.find((graph) => (
      graph.id === taskGraphId
      && graph.graphVersion === taskGraphVersion
      && graph.approval === 'approved'
    ));
    if (!taskGraph) {
      issues.push({ runId, message: `Run ${runId} 缺少批准且版本匹配的 TaskGraph，拒绝自动恢复` });
      continue;
    }

    const runEvents = projectEvents
      .filter((event) => {
        const eventPayload = payload(event);
        const eventRunId = text(eventPayload.runId) ?? (event.aggregateType === 'Run' ? event.aggregateId : undefined);
        return eventRunId === runId;
      })
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    try {
      replayDomainEvents(runEvents);
    } catch (cause) {
      issues.push({ runId, message: `Run ${runId} 事件生命周期校验失败：${cause instanceof Error ? cause.message : String(cause)}` });
      continue;
    }

    let state: WorkerRunQueueState;
    const runIssueStart = issues.length;
    try {
      state = createWorkerRunQueue({
        projectId: input.projectId,
        runId,
        orchestrationId: text(p.orchestrationId),
        taskGraph,
        now: created.occurredAt,
      }).snapshot();
    } catch (cause) {
      issues.push({ runId, message: `Run ${runId} 基础队列恢复失败：${cause instanceof Error ? cause.message : String(cause)}` });
      continue;
    }

    for (const event of input.events) {
      if (event.streamId !== input.projectId) continue;
      const eventPayload = payload(event);
      const eventRunId = text(eventPayload.runId) ?? (event.aggregateType === 'Run' ? event.aggregateId : undefined);
      if (eventRunId !== runId) continue;
      const nextRunStatus = runStatusFor(event.eventType);
      if (nextRunStatus) {
        if (nextRunStatus === 'succeeded' && !workerRunSuccessIsValid(Object.values(state.tasks))) {
          issues.push({ runId, message: `RunSucceeded 缺少完整 Worker success provenance：${runId}` });
          continue;
        }
        state = { ...state, status: nextRunStatus, updatedAt: event.occurredAt };
        continue;
      }
      if (event.eventType.startsWith('Task')) {
        state = applyTaskEvent(state, event, issues);
      }
    }
    if (issues.length > runIssueStart) {
      continue;
    }
    try {
      state = restoreWorkerRunQueue({ taskGraph, state }).snapshot();
    } catch (cause) {
      issues.push({ runId, message: `Run ${runId} 恢复后的 Worker 状态校验失败：${cause instanceof Error ? cause.message : String(cause)}` });
      continue;
    }
    runs.push(state);
  }

  return { runs, issues };
}

/**
 * Restore a missing ProjectFile WorkerRun projection before another save can erase it.
 * Existing in-memory runs are authoritative for this narrow guard; the helper is only
 * intended for the empty-projection race during project startup/recovery.
 */
export function restoreMissingWorkerRunsFromEvents(input: {
  projectId: string;
  events: readonly DomainEvent[];
  taskGraphs: readonly ProjectTaskGraph[];
  existingRuns?: readonly WorkerRunQueueState[];
}): MissingWorkerRunProjectionResult {
  const existingRuns = input.existingRuns ?? [];
  if (existingRuns.length > 0) {
    return { runs: [...existingRuns], issues: [], restored: false };
  }
  const result = rehydrateWorkerRunsFromEvents(input);
  return {
    ...result,
    restored: result.issues.length === 0 && result.runs.length > 0,
  };
}

/** Reconcile an existing ProjectFile snapshot with durable retry fences. */
export function reconcileWorkerRunsFromEvents(input: {
  projectId: string;
  events: readonly DomainEvent[];
  runs: readonly WorkerRunQueueState[];
}): WorkerRunSnapshotReconciliationResult {
  const issues: WorkerRunRehydrationIssue[] = [];
  const changedRunIds: string[] = [];
  const runs = input.runs.map((run) => {
    let state = run;
    for (const event of input.events) {
      if (event.streamId !== input.projectId) continue;
      const p = payload(event);
      const eventRunId = text(p.runId) ?? (event.aggregateType === 'Run' ? event.aggregateId : undefined);
      if (eventRunId !== run.runId) continue;
      if (event.eventType === 'RunQueued' && state.status !== 'succeeded') {
        state = { ...state, status: 'queued', updatedAt: event.occurredAt };
        continue;
      }
      const nextAttempt = positiveInteger(p.nextAttempt);
      if (event.eventType !== 'TaskQueued' || nextAttempt === undefined) continue;
      const taskId = text(p.taskId) ?? (event.aggregateType === 'Task' ? event.aggregateId : undefined);
      const current = taskId ? state.tasks[taskId] : undefined;
      if (!taskId || !current || (current.status === 'succeeded' && current.attempt >= nextAttempt)) continue;
      const before = JSON.stringify(state);
      state = applyTaskEvent(state, event, issues);
      if (JSON.stringify(state) === before) continue;
    }
    const repairedTasks = Object.fromEntries(
      Object.entries(state.tasks).map(([taskId, task]) => [
        taskId,
        task.pendingAttempt !== undefined && task.status !== 'queued'
          ? { ...task, pendingAttempt: undefined }
          : task,
      ]),
    );
    state = { ...state, tasks: repairedTasks };
    if (JSON.stringify(state) !== JSON.stringify(run)) changedRunIds.push(run.runId);
    return state;
  });
  return { runs, changedRunIds, issues };
}
