import type { DomainEvent } from '../../domain/contracts';
import type { ProjectControlSnapshot } from '../types';
import type { Orchestration } from '../../types/orchestration';
import { createEmptyProjectControlSnapshot } from '../persistence';
import { createIssue } from '../issue';
import {
  approveArchitecture,
  approveBrief,
  createProjectSession,
  transitionSession,
} from '../state';
import { appendFact, requiredText, type ProjectControlCommandResult } from './shared';

export interface StartProjectSessionCommandInput {
  projectId: string;
  sessionId: string;
  issueId: string;
  projectName: string;
  goal: string;
  now: string;
}

export interface StartProjectSessionCommandResult {
  snapshot: ProjectControlSnapshot;
  events: DomainEvent[];
}

/**
 * Application command for the only empty-home entry point.
 * It builds the projection and its facts together; callers decide when/how to
 * persist the returned event batch (a new unsaved project has no disk root yet).
 */
export function startProjectSessionCommand(
  input: StartProjectSessionCommandInput,
): StartProjectSessionCommandResult {
  const projectId = requiredText(input.projectId, '项目 id');
  const sessionId = requiredText(input.sessionId, '会话 id');
  const issueId = requiredText(input.issueId, 'Issue id');
  const projectName = requiredText(input.projectName, '项目名称');
  const goal = requiredText(input.goal, '项目目标');
  const now = requiredText(input.now, '时间');

  const session = createProjectSession({
    id: sessionId,
    projectId,
    goal,
    now,
  });
  const issue = createIssue({
    id: issueId,
    projectId,
    type: 'feature',
    title: projectName,
    description: goal,
    sourceSessionId: session.id,
    createdAt: now,
  });
  const snapshot: ProjectControlSnapshot = {
    ...createEmptyProjectControlSnapshot(),
    activeSessionId: session.id,
    sessions: [session],
    issues: [issue],
  };
  const events: DomainEvent[] = [];
  const common = {
    streamId: projectId,
    schemaVersion: 1,
    actor: 'user' as const,
    occurredAt: now,
    correlationId: sessionId,
    sensitivity: 'normal' as const,
  };

  appendFact(events, {
    ...common,
    eventId: `${sessionId}:project-created`,
    aggregateType: 'Project',
    aggregateId: projectId,
    eventType: 'ProjectCreated',
    payload: { projectId, name: projectName },
    source: { objectId: projectId, objectVersion: 1 },
  });
  appendFact(events, {
    ...common,
    eventId: `${sessionId}:session-started`,
    aggregateType: 'Session',
    aggregateId: sessionId,
    eventType: 'SessionStarted',
    payload: { projectId, goal },
    source: { objectId: sessionId, objectVersion: 1 },
  });
  appendFact(events, {
    ...common,
    eventId: `${sessionId}:issue-created`,
    aggregateType: 'Issue',
    aggregateId: issueId,
    eventType: 'IssueCreated',
    payload: {
      projectId,
      title: projectName,
      sourceSessionId: sessionId,
      issueType: issue.type,
    },
    source: { objectId: issueId, objectVersion: 1 },
  });

  return { snapshot, events };
}

export function createExecutionDraftCreatedEvent(input: {
  projectId: string;
  sessionId: string;
  orchestration: Orchestration;
  taskGraphId: string;
  taskGraphVersion: number;
  now: string;
}): DomainEvent {
  return {
    eventId: `${input.orchestration.id}:execution-draft-created`,
    streamId: input.projectId,
    sequence: 1,
    aggregateType: 'Orchestration',
    aggregateId: input.orchestration.id,
    aggregateVersion: 1,
    eventType: 'ExecutionDraftCreated',
    schemaVersion: 1,
    payload: {
      orchestrationId: input.orchestration.id,
      sessionId: input.sessionId,
      taskGraphId: input.taskGraphId,
      stageIds: input.orchestration.draft?.stages.map((stage) => stage.id) ?? [],
    },
    actor: 'runtime',
    occurredAt: input.now,
    correlationId: input.sessionId,
    source: { objectId: input.taskGraphId, objectVersion: input.taskGraphVersion },
    sensitivity: 'normal',
  };
}

export interface LinkOrchestrationCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  orchestrationId: string;
  now: string;
}

export function linkOrchestrationCommand(
  input: LinkOrchestrationCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  const orchestrationId = requiredText(input.orchestrationId, '编排 id');
  if (session.orchestrationId && session.orchestrationId !== orchestrationId) {
    throw new Error(`会话已经关联其它执行编排：${session.orchestrationId}`);
  }

  const nextSession = {
    ...transitionSession(session, 'ready', input.now),
    orchestrationId,
  };
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    sessions: input.snapshot.sessions.map((item) => (item.id === session.id ? nextSession : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${session.id}:orchestration-linked:${orchestrationId}`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionOrchestrationLinked',
    schemaVersion: 1,
    payload: {
      sessionId: session.id,
      orchestrationId,
      from: session.status,
      to: nextSession.status,
    },
    actor: 'runtime',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}

export interface ApproveBriefCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  approvedBy: string;
  now: string;
}

export function approveBriefCommand(
  input: ApproveBriefCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  if (!session.briefId) throw new Error('当前会话没有待批准的 Brief');
  const brief = input.snapshot.briefs.find((item) => item.id === session.briefId);
  if (!brief) throw new Error(`Brief 不存在：${session.briefId}`);

  const approved = approveBrief(brief, input.approvedBy, input.now);
  const nextSession = transitionSession(session, 'architecture-review', input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    briefs: input.snapshot.briefs.map((item) => (item.id === approved.id ? approved : item)),
    sessions: input.snapshot.sessions.map((item) => (item.id === session.id ? nextSession : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${approved.id}:approved:${approved.approvedAt ?? input.now}`,
    streamId: session.projectId,
    aggregateType: 'Brief',
    aggregateId: approved.id,
    eventType: 'BriefApproved',
    schemaVersion: 1,
    payload: {
      briefId: approved.id,
      sessionId: session.id,
      approvedBy: approved.approvedBy,
      briefVersion: approved.briefVersion,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: approved.id, objectVersion: approved.briefVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${session.id}:status:${input.now}:architecture-review`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionStatusChanged',
    schemaVersion: 1,
    payload: {
      sessionId: session.id,
      from: session.status,
      to: nextSession.status,
      reason: 'brief-approved',
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}

export interface ApproveArchitectureCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  approvedBy: string;
  now: string;
}

export function approveArchitectureCommand(
  input: ApproveArchitectureCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  if (!session.architectureId) throw new Error('当前会话没有待批准的架构');
  const architecture = input.snapshot.architectures.find((item) => item.id === session.architectureId);
  if (!architecture) throw new Error(`架构不存在：${session.architectureId}`);

  const approved = approveArchitecture(architecture, input.approvedBy, input.now);
  const nextSession = transitionSession(session, 'plan-review', input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    architectures: input.snapshot.architectures.map((item) => (item.id === approved.id ? approved : item)),
    sessions: input.snapshot.sessions.map((item) => (item.id === session.id ? nextSession : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${approved.id}:approved:${approved.approvedAt ?? input.now}`,
    streamId: session.projectId,
    aggregateType: 'Architecture',
    aggregateId: approved.id,
    eventType: 'ArchitectureApproved',
    schemaVersion: 1,
    payload: {
      architectureId: approved.id,
      sessionId: session.id,
      approvedBy: approved.approvedBy,
      architectureVersion: approved.architectureVersion,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: approved.id, objectVersion: approved.architectureVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${session.id}:status:${input.now}:plan-review`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionStatusChanged',
    schemaVersion: 1,
    payload: {
      sessionId: session.id,
      from: session.status,
      to: nextSession.status,
      reason: 'architecture-approved',
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}
