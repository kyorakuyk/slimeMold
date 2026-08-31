import {
  appendDomainEvent,
  type DomainEvent,
} from './contracts';
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

export interface SyntheticBaselineMigrationInput {
  projectId: string;
  snapshot: ProjectControlSnapshot;
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
