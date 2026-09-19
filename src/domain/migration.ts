import {
  appendDomainEvent,
  type DomainEvent,
} from './contracts';
import { createAttemptId, createTaskExecutionId } from './execution';
import { EventStoreError, integrityChecksum, type EventStreamRepository } from './eventStore';
import type {
  Decision,
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectIssue,
  ProjectSession,
  ProjectTask,
  ProjectTaskGraph,
} from '../projectControl/types';
import type { WorkerRunQueueState } from './workerQueue';
import { normalizeWorkerSuccessProvenance, workerRunSuccessIsValid } from './workerSuccess';

export interface SyntheticBaselineMigrationInput {
  projectId: string;
  snapshot: ProjectControlSnapshot;
  workerRuns?: readonly WorkerRunQueueState[];
  now: string;
  migrationId?: string;
}

export interface SyntheticBaselineMigrationResult {
  status: 'created' | 'already-present';
  migrationId: string;
  events: DomainEvent[];
}

export async function migrateLegacyProjectControl(
  repository: EventStreamRepository,
  input: SyntheticBaselineMigrationInput,
): Promise<SyntheticBaselineMigrationResult> {
  const projectId = requireText(input.projectId, 'projectId');
  const migrationId = requireText(input.migrationId ?? `${projectId}:v1-to-v2`, 'migrationId');
  const parsed = await repository.readStream();
  if (parsed.status === 'needs-repair') {
    throw new EventStoreError(
      'needs-repair',
      `迁移前事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
    );
  }

  const hasBaseline = parsed.events.some(
    (event) => event.eventType === 'ProjectControlBaselineImported' && event.streamId === projectId,
  );
  if (hasBaseline) return { status: 'already-present', migrationId, events: parsed.events };
  if (parsed.events.length > 0) {
    throw new EventStoreError('event-conflict', `非空事件流不能直接写入 legacy migration baseline：${projectId}`);
  }

  const events = createSyntheticBaselineEvents({ ...input, projectId, migrationId });
  const appended = await repository.appendBatch(events, 0);
  return { status: 'created', migrationId, events: appended.events };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function source(projectId: string, type: string, id: string) {
  return { objectId: `${projectId}:${type}:${id}`, objectVersion: 1 };
}

function originalTime(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

/**
 * Convert a legacy control snapshot into an explicitly synthetic baseline.
 *
 * These events describe what was found during migration. They do not recreate
 * user approvals or claim that the old snapshot had an append-only history.
 */
export function createSyntheticBaselineEvents(
  input: SyntheticBaselineMigrationInput,
): DomainEvent[] {
  const projectId = requireText(input.projectId, 'projectId');
  const migrationId = requireText(input.migrationId ?? `${projectId}:v1-to-v2`, 'migrationId');
  const events: DomainEvent[] = [];
  const versions = new Map<string, number>();

  const add = (event: Omit<DomainEvent, 'sequence' | 'aggregateVersion'>): void => {
    const aggregateKey = `${event.aggregateType}:${event.aggregateId}`;
    const aggregateVersion = (versions.get(aggregateKey) ?? 0) + 1;
    const next = {
      ...event,
      sequence: events.length + 1,
      aggregateVersion,
    } satisfies DomainEvent;
    const appended = appendDomainEvent(events, next);
    events.splice(0, events.length, ...appended);
    versions.set(aggregateKey, aggregateVersion);
  };

  const snapshot = input.snapshot;
  if (snapshot.sessions.some((session) => session.projectId !== projectId)) {
    throw new Error(`legacy session 不属于迁移项目：${projectId}`);
  }
  if (snapshot.issues.some((issue) => issue.projectId !== projectId)) {
    throw new Error(`legacy issue 不属于迁移项目：${projectId}`);
  }
  for (const workerRun of input.workerRuns ?? []) {
    if (workerRun.projectId !== projectId) {
      throw new Error(`legacy WorkerRun 不属于迁移项目：${workerRun.runId}`);
    }
  }
  const taskGraphs = snapshot.taskGraphs ?? [];
  add({
    eventId: `${migrationId}:project-control-baseline`,
    streamId: projectId,
    aggregateType: 'Project',
    aggregateId: projectId,
    eventType: 'ProjectControlBaselineImported',
    schemaVersion: 1,
    payload: {
      migrationId,
      legacyVersion: snapshot.version,
      activeSessionId: snapshot.activeSessionId,
      masterAgentId: snapshot.masterAgentId ?? null,
      counts: {
        sessions: snapshot.sessions.length,
        decisions: snapshot.decisions.length,
        briefs: snapshot.briefs.length,
        architectures: snapshot.architectures.length,
        issues: snapshot.issues.length,
        taskGraphs: taskGraphs.length,
      },
    },
    actor: 'system',
    occurredAt: input.now,
    correlationId: migrationId,
    source: { objectId: `${projectId}:projectControl`, objectVersion: 1 },
    sensitivity: 'normal',
    synthetic: true,
  });

  if (snapshot.masterAgentId) {
    add({
      eventId: `${migrationId}:project-master-override`,
      streamId: projectId,
      aggregateType: 'Project',
      aggregateId: projectId,
      eventType: 'ProjectMasterOverrideSet',
      schemaVersion: 1,
      payload: {
        masterAgentId: snapshot.masterAgentId,
        reason: 'legacy-project-control-import',
      },
      actor: 'system',
      occurredAt: input.now,
      correlationId: migrationId,
      source: source(projectId, 'projectControl', 'masterAgentId'),
      sensitivity: 'normal',
      synthetic: true,
    });
  }

  for (const session of snapshot.sessions) addSession(add, projectId, migrationId, input.now, session);
  for (const decision of snapshot.decisions) addDecision(add, projectId, migrationId, input.now, decision);
  for (const brief of snapshot.briefs) addBrief(add, projectId, migrationId, input.now, brief);
  for (const architecture of snapshot.architectures) {
    addArchitecture(add, projectId, migrationId, input.now, architecture);
  }
  for (const issue of snapshot.issues) addIssue(add, projectId, migrationId, input.now, issue);
  for (const graph of taskGraphs) addTaskGraph(add, projectId, migrationId, input.now, graph);
  for (const workerRun of input.workerRuns ?? []) {
    addWorkerRun(add, projectId, migrationId, input.now, workerRun);
  }

  return events;
}

type AddEvent = (event: Omit<DomainEvent, 'sequence' | 'aggregateVersion'>) => void;

function commonImportedFields(
  projectId: string,
  migrationId: string,
  type: string,
  id: string,
  now: string,
  occurredAt: string,
) {
  return {
    streamId: projectId,
    schemaVersion: 1,
    actor: 'system' as const,
    occurredAt: originalTime(occurredAt, now),
    correlationId: migrationId,
    source: source(projectId, type, id),
    sensitivity: 'normal' as const,
    synthetic: true,
  };
}

function addSession(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  session: ProjectSession,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'session', session.id, now, session.updatedAt),
    eventId: `${migrationId}:session:${session.id}`,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'LegacySessionImported',
    payload: {
      id: session.id,
      projectId: session.projectId,
      status: session.status,
      messageCount: session.messages.length,
      openQuestionCount: session.openQuestions.length,
      decisionIds: [...session.decisionIds],
      briefId: session.briefId ?? null,
      architectureId: session.architectureId ?? null,
      taskGraphId: session.taskGraphId ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
  });
}

function addDecision(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  decision: Decision,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'decision', decision.id, now, decision.updatedAt),
    eventId: `${migrationId}:decision:${decision.id}`,
    aggregateType: 'Decision',
    aggregateId: decision.id,
    eventType: 'LegacyDecisionImported',
    payload: {
      id: decision.id,
      sessionId: decision.sessionId,
      key: decision.key,
      status: decision.status,
      valueHash: integrityChecksum(decision.value),
      rationale: decision.rationale ?? null,
      approvedBy: decision.approvedBy ?? null,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
    },
  });
}

function addBrief(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  brief: ProjectBrief,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'brief', brief.id, now, brief.updatedAt),
    eventId: `${migrationId}:brief:${brief.id}`,
    aggregateType: 'Brief',
    aggregateId: brief.id,
    eventType: 'LegacyBriefImported',
    payload: {
      id: brief.id,
      sessionId: brief.sessionId,
      briefVersion: brief.briefVersion,
      approval: brief.approval,
      goalHash: integrityChecksum(brief.goal),
      usersCount: brief.users.length,
      scopeCount: brief.scope.length,
      acceptanceCriteriaCount: brief.acceptanceCriteria.length,
      createdAt: brief.createdAt,
      updatedAt: brief.updatedAt,
      approvedBy: brief.approvedBy ?? null,
    },
  });
}

function addArchitecture(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  architecture: ProjectArchitecture,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'architecture', architecture.id, now, architecture.updatedAt),
    eventId: `${migrationId}:architecture:${architecture.id}`,
    aggregateType: 'Architecture',
    aggregateId: architecture.id,
    eventType: 'LegacyArchitectureImported',
    payload: {
      id: architecture.id,
      sessionId: architecture.sessionId,
      briefId: architecture.briefId,
      architectureVersion: architecture.architectureVersion,
      approval: architecture.approval,
      moduleIds: architecture.modules.map((module) => module.id),
      interfaceIds: architecture.interfaces.map((item) => item.id),
      taskIds: architecture.tasks.map((task) => task.id),
      riskCount: architecture.risks.length,
      overviewHash: integrityChecksum(architecture.overview),
      createdAt: architecture.createdAt,
      updatedAt: architecture.updatedAt,
    },
  });
}

function addIssue(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  issue: ProjectIssue,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'issue', issue.id, now, issue.updatedAt),
    eventId: `${migrationId}:issue:${issue.id}`,
    aggregateType: 'Issue',
    aggregateId: issue.id,
    eventType: 'LegacyIssueImported',
    payload: {
      id: issue.id,
      projectId: issue.projectId,
      proposedProjectId: issue.proposedProjectId ?? null,
      type: issue.type,
      status: issue.status,
      priority: issue.priority,
      title: issue.title,
      tags: [...issue.tags],
      relatedArtifactIds: [...issue.relatedArtifactIds],
      relatedTaskIds: [...issue.relatedTaskIds],
      relatedRunId: issue.relatedRunId ?? null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
  });
}

function addTaskGraph(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  graph: ProjectTaskGraph,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'taskGraph', graph.id, now, graph.updatedAt),
    eventId: `${migrationId}:task-graph:${graph.id}`,
    aggregateType: 'TaskGraph',
    aggregateId: graph.id,
    eventType: 'LegacyTaskGraphImported',
    payload: {
      id: graph.id,
      sessionId: graph.sessionId,
      architectureId: graph.architectureId,
      graphVersion: graph.graphVersion,
      approval: graph.approval,
      taskIds: graph.tasks.map((task) => task.id),
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
    },
  });
  for (const task of graph.tasks) addTask(add, projectId, migrationId, now, task);
}

function addTask(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  task: ProjectTask,
): void {
  add({
    ...commonImportedFields(projectId, migrationId, 'task', task.id, now, task.updatedAt),
    eventId: `${migrationId}:task:${task.id}`,
    aggregateType: 'Task',
    aggregateId: task.id,
    eventType: 'LegacyTaskImported',
    payload: {
      id: task.id,
      architectureId: task.architectureId,
      issueId: task.issueId ?? null,
      title: task.title,
      moduleId: task.moduleId,
      scope: [...task.scope],
      dependsOn: [...task.dependsOn],
      acceptanceCriteria: [...task.acceptanceCriteria],
      category: task.category,
      status: task.status,
      workflowId: task.workflowId ?? null,
      stageId: task.stageId ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  });
}

function runEventType(status: WorkerRunQueueState['status']): string {
  switch (status) {
    case 'queued': return 'RunQueued';
    case 'running': return 'RunStarted';
    case 'partial': return 'RunPartial';
    case 'blocked': return 'RunBlocked';
    case 'failed': return 'RunFailed';
    case 'cancelled': return 'RunCancelled';
    case 'succeeded': return 'RunSucceeded';
  }
}

function taskEventType(status: WorkerRunQueueState['tasks'][string]['status']): string {
  switch (status) {
    case 'queued': return 'TaskQueued';
    case 'running': return 'TaskStarted';
    case 'waiting-feedback': return 'TaskFeedbackRequested';
    case 'succeeded': return 'TaskSucceeded';
    case 'failed': return 'TaskFailed';
    case 'blocked': return 'TaskBlocked';
    case 'cancelled': return 'TaskCancelled';
  }
}

function workerTaskLineage(run: WorkerRunQueueState, taskId: string): {
  taskExecutionId: string;
  attemptId?: string;
} {
  const task = run.tasks[taskId];
  const taskExecutionId = createTaskExecutionId(run.runId, taskId);
  if (task.taskExecutionId && task.taskExecutionId !== taskExecutionId) {
    throw new Error(`legacy Worker taskExecutionId 不一致：${run.runId}/${taskId}`);
  }
  if (task.status === 'queued' || task.status === 'blocked' || task.status === 'cancelled') {
    if (task.currentAttemptId) {
      throw new Error(`legacy Worker inactive task 不能带 currentAttemptId：${run.runId}/${taskId}`);
    }
    return { taskExecutionId };
  }
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) {
    throw new Error(`legacy Worker task 缺少有效 attempt：${run.runId}/${taskId}`);
  }
  const attemptId = createAttemptId(taskExecutionId, task.attempt);
  if (task.currentAttemptId && task.currentAttemptId !== attemptId) {
    throw new Error(`legacy Worker attemptId 不一致：${run.runId}/${taskId}`);
  }
  return { taskExecutionId, attemptId };
}

function addWorkerRun(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  run: WorkerRunQueueState,
): void {
  if (run.status === 'succeeded' && !workerRunSuccessIsValid(Object.values(run.tasks))) {
    throw new Error(`legacy Worker Run succeeded 缺少完整 success provenance：${run.runId}`);
  }
  add({
    ...commonImportedFields(projectId, migrationId, 'workerRun', run.runId, now, run.updatedAt),
    eventId: `${migrationId}:worker-run:${run.runId}`,
    aggregateType: 'Run',
    aggregateId: run.runId,
    eventType: runEventType(run.status),
    payload: {
      runId: run.runId,
      orchestrationId: run.orchestrationId ?? null,
      taskGraphId: run.taskGraphId,
      taskGraphVersion: run.taskGraphVersion,
      taskIds: Object.keys(run.tasks),
      status: run.status,
    },
  });
  for (const [taskId, task] of Object.entries(run.tasks)) {
    addWorkerTask(add, projectId, migrationId, now, run, taskId, task);
  }
}

function addImportedAttempt(
  add: AddEvent,
  common: ReturnType<typeof commonImportedFields>,
  migrationId: string,
  run: WorkerRunQueueState,
  taskId: string,
  taskExecutionId: string,
  attempt: number,
): void {
  const attemptId = createAttemptId(taskExecutionId, attempt);
  add({
    ...common,
    eventId: `${migrationId}:worker-task:${taskExecutionId}:TaskAttemptImported:${attempt}`,
    aggregateType: 'TaskExecution',
    aggregateId: taskExecutionId,
    eventType: 'TaskAttemptImported',
    payload: {
      runId: run.runId,
      taskId,
      taskExecutionId,
      attempt,
      attemptId,
      reason: 'legacy-worker-snapshot-without-attempt-history',
    },
  });
}

function addWorkerTask(
  add: AddEvent,
  projectId: string,
  migrationId: string,
  now: string,
  run: WorkerRunQueueState,
  taskId: string,
  task: WorkerRunQueueState['tasks'][string],
): void {
  if (task.status === 'succeeded') normalizeWorkerSuccessProvenance(task.evidenceIds, task.acceptanceId);
  const { taskExecutionId, attemptId } = workerTaskLineage(run, taskId);
  const common = commonImportedFields(projectId, migrationId, 'workerTask', `${run.runId}:${taskId}`, now, task.updatedAt);
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 0) {
    throw new Error(`legacy Worker task attempt 无效：${run.runId}/${taskId}`);
  }
  const importedAttemptCount = task.status === 'queued' || task.status === 'blocked' || task.status === 'cancelled'
    ? task.attempt
    : Math.max(task.attempt - 1, 0);
  for (let attempt = 1; attempt <= importedAttemptCount; attempt += 1) {
    addImportedAttempt(add, common, migrationId, run, taskId, taskExecutionId, attempt);
  }
  const attemptPayload = attemptId
    ? {
        attempt: task.attempt,
        attemptId,
        ...(task.worktreeId ? { worktreeId: task.worktreeId } : {}),
        ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
        ...(task.branch ? { branch: task.branch } : {}),
        ...(task.baseRevision ? { baseRevision: task.baseRevision } : {}),
        ...(task.evidenceIds.length > 0 ? { evidenceIds: [...task.evidenceIds] } : {}),
        ...(task.acceptanceId ? { acceptanceId: task.acceptanceId } : {}),
        ...(task.error ? { error: task.error } : {}),
      }
    : {};
  if (attemptId && task.attempt > 1) {
    add({
      ...common,
      eventId: `${migrationId}:worker-task:${taskExecutionId}:TaskQueued:${task.attempt}`,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskQueued',
      payload: {
        runId: run.runId,
        taskId,
        taskExecutionId,
        nextAttempt: task.attempt,
      },
    });
  }
  if (attemptId && (task.status === 'succeeded' || task.status === 'failed')) {
    add({
      ...common,
      eventId: `${migrationId}:worker-task:${taskExecutionId}:TaskStarted:${task.attempt}`,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: {
        runId: run.runId,
        taskId,
        taskExecutionId,
        ...attemptPayload,
      },
    });
  }
  const payload = {
    runId: run.runId,
    taskId,
    taskExecutionId,
    ...attemptPayload,
    ...(task.status === 'waiting-feedback' && task.feedbackId ? { feedbackId: task.feedbackId } : {}),
    ...(task.status === 'queued' && task.attempt > 0 ? { nextAttempt: task.attempt + 1 } : {}),
  };
  add({
    ...common,
    eventId: `${migrationId}:worker-task:${taskExecutionId}:${taskEventType(task.status)}`,
    aggregateType: 'TaskExecution',
    aggregateId: taskExecutionId,
    eventType: taskEventType(task.status),
    payload,
  });
  if (task.status === 'succeeded' && task.cleanupStatus === 'cleaned') {
    add({
      ...common,
      eventId: `${migrationId}:worker-task:${taskExecutionId}:TaskCleaned`,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskCleaned',
      payload: {
        runId: run.runId,
        taskId,
        taskExecutionId,
        attempt: task.attempt,
        attemptId,
        receiptId: task.cleanupReceiptId,
        cleanupStatus: 'cleaned',
      },
    });
  }
}
