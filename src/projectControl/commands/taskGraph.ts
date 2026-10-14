import type { DomainEvent } from '../../domain/contracts';
import type { ProjectControlSnapshot } from '../types';
import { transitionIssue } from '../issue';
import { transitionSession } from '../state';
import { approveTaskGraph, createTaskGraphFromArchitecture, reviseTaskGraph } from '../taskGraph';
import { materializeTaskIssues, taskIssueId } from '../taskGraphProjection';
import { checkGrowth } from '../growthPolicy';
import { triageTaskGraph } from '../triage';
import { appendFact, type ProjectControlCommandResult } from './shared';

export interface GenerateTaskGraphCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  id: string;
  now: string;
  version?: number;
}

export function generateTaskGraphCommand(
  input: GenerateTaskGraphCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  if (!session.architectureId) throw new Error('当前会话没有可生成任务图的架构');
  const architecture = input.snapshot.architectures.find((item) => item.id === session.architectureId);
  if (!architecture) throw new Error(`架构不存在：${session.architectureId}`);
  const graph = createTaskGraphFromArchitecture({
    id: input.id,
    architecture,
    now: input.now,
    version: input.version,
  });
  const taskIssues = materializeTaskIssues({
    graph,
    projectId: session.projectId,
    existingIssues: input.snapshot.issues,
    now: input.now,
  });
  const triage = triageTaskGraph(graph);
  const growthViolations = checkGrowth(graph, triage);
  const nextSession = transitionSession(session, 'plan-review', input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: taskIssues.issues,
    taskGraphs: [...(input.snapshot.taskGraphs ?? []), graph],
    sessions: input.snapshot.sessions.map((item) =>
      item.id === session.id ? { ...nextSession, taskGraphId: graph.id } : item,
    ),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${graph.id}:proposed`,
    streamId: session.projectId,
    aggregateType: 'TaskGraph',
    aggregateId: graph.id,
    eventType: 'TaskGraphProposed',
    schemaVersion: 1,
    payload: {
      taskGraphId: graph.id,
      sessionId: session.id,
      architectureId: graph.architectureId,
      graphVersion: graph.graphVersion,
      taskIds: graph.tasks.map((task) => task.id),
      graph,
      triage: { ...triage, violations: growthViolations },
    },
    actor: 'master',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: graph.id, objectVersion: graph.graphVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${session.id}:task-graph-linked:${graph.id}`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionTaskGraphLinked',
    schemaVersion: 1,
    payload: { sessionId: session.id, taskGraphId: graph.id },
    actor: 'master',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  for (const issueId of taskIssues.createdIssueIds) {
    const issue = taskIssues.issues.find((item) => item.id === issueId);
    if (!issue) throw new Error(`Task Issue materialization 丢失：${issueId}`);
    appendFact(events, {
      eventId: `${issue.id}:created`,
      streamId: session.projectId,
      aggregateType: 'Issue',
      aggregateId: issue.id,
      eventType: 'IssueCreated',
      schemaVersion: 1,
      payload: {
        issueId: issue.id,
        projectId: session.projectId,
        issueType: issue.type,
        title: issue.title,
        sourceTaskGraphId: graph.id,
        taskId: issue.relatedTaskIds[0],
      },
      actor: 'master',
      occurredAt: input.now,
      correlationId: session.id,
      source: { objectId: graph.id, objectVersion: graph.graphVersion },
      sensitivity: 'normal',
    });
  }
  return { snapshot, events };
}

export interface ReviseTaskGraphCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  sourceTaskGraphId: string;
  id: string;
  now: string;
  changes: Parameters<typeof reviseTaskGraph>[0]['changes'];
}

export function reviseTaskGraphCommand(
  input: ReviseTaskGraphCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  const source = input.snapshot.taskGraphs?.find((item) => item.id === input.sourceTaskGraphId);
  if (!source) throw new Error(`源任务图不存在：${input.sourceTaskGraphId}`);
  if (source.sessionId !== session.id) throw new Error('任务图不属于当前会话');
  if (!['plan-review', 'ready', 'blocked', 'awaiting-user'].includes(session.status)) {
    throw new Error(`当前会话状态不允许修改任务图：${session.status}`);
  }
  const revised = reviseTaskGraph({
    graph: source,
    id: input.id,
    now: input.now,
    changes: input.changes,
  });
  const taskIssues = materializeTaskIssues({
    graph: revised,
    projectId: session.projectId,
    existingIssues: input.snapshot.issues,
    now: input.now,
  });
  const superseded = {
    ...source,
    approval: 'superseded' as const,
    supersededBy: revised.id,
    updatedAt: input.now,
  };
  const nextSession = session.status === 'plan-review'
    ? { ...session, taskGraphId: revised.id, updatedAt: input.now }
    : transitionSession({ ...session, taskGraphId: revised.id }, 'plan-review', input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: taskIssues.issues,
    taskGraphs: [
      ...(input.snapshot.taskGraphs ?? []).map((item) => (item.id === source.id ? superseded : item)),
      revised,
    ],
    sessions: input.snapshot.sessions.map((item) => (item.id === session.id ? nextSession : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${source.id}:superseded:${revised.id}`,
    streamId: session.projectId,
    aggregateType: 'TaskGraph',
    aggregateId: source.id,
    eventType: 'TaskGraphSuperseded',
    schemaVersion: 1,
    payload: {
      taskGraphId: source.id,
      supersededBy: revised.id,
      graphVersion: source.graphVersion,
      graph: superseded,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: source.id, objectVersion: source.graphVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${revised.id}:revision-created`,
    streamId: session.projectId,
    aggregateType: 'TaskGraph',
    aggregateId: revised.id,
    eventType: 'TaskGraphRevisionCreated',
    schemaVersion: 1,
    payload: {
      taskGraphId: revised.id,
      revisionOf: source.id,
      sessionId: session.id,
      graphVersion: revised.graphVersion,
      taskIds: revised.tasks.map((task) => task.id),
      graph: revised,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: revised.id, objectVersion: revised.graphVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${session.id}:task-graph-linked:${revised.id}`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionTaskGraphLinked',
    schemaVersion: 1,
    payload: { sessionId: session.id, taskGraphId: revised.id, revisionOf: source.id },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  for (const issueId of taskIssues.createdIssueIds) {
    const issue = taskIssues.issues.find((item) => item.id === issueId);
    if (!issue) throw new Error(`Task Issue materialization 丢失：${issueId}`);
    appendFact(events, {
      eventId: `${issue.id}:created`,
      streamId: session.projectId,
      aggregateType: 'Issue',
      aggregateId: issue.id,
      eventType: 'IssueCreated',
      schemaVersion: 1,
      payload: {
        issueId: issue.id,
        projectId: session.projectId,
        issueType: issue.type,
        title: issue.title,
        sourceTaskGraphId: revised.id,
        revisionOf: source.id,
        taskId: issue.relatedTaskIds[0],
      },
      actor: 'user',
      occurredAt: input.now,
      correlationId: session.id,
      source: { objectId: revised.id, objectVersion: revised.graphVersion },
      sensitivity: 'normal',
    });
  }
  return { snapshot, events };
}

export interface ApproveTaskGraphCommandInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  approvedBy: string;
  now: string;
}

/** Convert approval into a next snapshot/event batch: approve the graph, transition eligible Issues, and ready the Session.
 * It returns the new snapshot and DomainEvent batch; persistence and execution dispatch stay outside this function (ADR-SM-007、ADR-SM-010、ADR-SM-013).
 */
export function approveTaskGraphCommand(
  input: ApproveTaskGraphCommandInput,
): ProjectControlCommandResult {
  const session = input.snapshot.sessions.find((item) => item.id === input.sessionId);
  if (!session) throw new Error(`项目会话不存在：${input.sessionId}`);
  if (!session.taskGraphId) throw new Error('当前会话没有待批准的任务图');
  const graph = input.snapshot.taskGraphs?.find((item) => item.id === session.taskGraphId);
  if (!graph) throw new Error(`任务图不存在：${session.taskGraphId}`);

  const approved = approveTaskGraph(graph, input.approvedBy, input.now);
  const taskIssues = materializeTaskIssues({
    graph: approved,
    projectId: session.projectId,
    existingIssues: input.snapshot.issues,
    now: input.now,
  });
  let nextIssues = taskIssues.issues;
  const issueTransitions: Array<{ before: ProjectControlSnapshot['issues'][number]; after: ProjectControlSnapshot['issues'][number] }> = [];
  for (const task of approved.tasks) {
    const issueId = task.issueId ?? taskIssueId(approved.id, task.id);
    const issue = nextIssues.find((item) => item.id === issueId);
    if (!issue) throw new Error(`Task Issue 不存在，不能批准任务图：${issueId}`);
    if (issue.status !== 'proposed' && issue.status !== 'inbox' && issue.status !== 'triaging') continue;
    const nextIssue = transitionIssue(issue, 'approved', input.now);
    nextIssues = nextIssues.map((item) => (item.id === issue.id ? nextIssue : item));
    issueTransitions.push({ before: issue, after: nextIssue });
  }
  const nextSession = transitionSession(session, 'ready', input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: nextIssues,
    taskGraphs: (input.snapshot.taskGraphs ?? []).map((item) => (item.id === approved.id ? approved : item)),
    sessions: input.snapshot.sessions.map((item) => (item.id === session.id ? nextSession : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${approved.id}:approved:${approved.approvedAt ?? input.now}`,
    streamId: session.projectId,
    aggregateType: 'TaskGraph',
    aggregateId: approved.id,
    eventType: 'TaskGraphApproved',
    schemaVersion: 1,
    payload: {
      taskGraphId: approved.id,
      sessionId: session.id,
      approvedBy: approved.approvedBy,
      graphVersion: approved.graphVersion,
      graph: approved,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: approved.id, objectVersion: approved.graphVersion },
    sensitivity: 'private',
  });
  appendFact(events, {
    eventId: `${session.id}:status:${input.now}:ready`,
    streamId: session.projectId,
    aggregateType: 'Session',
    aggregateId: session.id,
    eventType: 'SessionStatusChanged',
    schemaVersion: 1,
    payload: {
      sessionId: session.id,
      from: session.status,
      to: nextSession.status,
      reason: 'task-graph-approved',
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: session.id,
    source: { objectId: session.id, objectVersion: 1 },
    sensitivity: 'normal',
  });
  for (const issueId of taskIssues.createdIssueIds) {
    const issue = taskIssues.issues.find((item) => item.id === issueId);
    if (!issue) throw new Error(`Task Issue materialization 丢失：${issueId}`);
    appendFact(events, {
      eventId: `${issue.id}:created`,
      streamId: session.projectId,
      aggregateType: 'Issue',
      aggregateId: issue.id,
      eventType: 'IssueCreated',
      schemaVersion: 1,
      payload: {
        issueId: issue.id,
        projectId: session.projectId,
        issueType: issue.type,
        title: issue.title,
        sourceTaskGraphId: approved.id,
        taskId: issue.relatedTaskIds[0],
      },
      actor: 'user',
      occurredAt: input.now,
      correlationId: session.id,
      source: { objectId: approved.id, objectVersion: approved.graphVersion },
      sensitivity: 'normal',
    });
  }
  for (const transition of issueTransitions) {
    appendFact(events, {
      eventId: `${transition.after.id}:status:${input.now}:approved`,
      streamId: session.projectId,
      aggregateType: 'Issue',
      aggregateId: transition.after.id,
      eventType: 'IssueStatusChanged',
      schemaVersion: 1,
      payload: {
        issueId: transition.after.id,
        taskGraphId: approved.id,
        taskId: transition.after.relatedTaskIds[0],
        from: transition.before.status,
        to: transition.after.status,
      },
      actor: 'user',
      occurredAt: input.now,
      correlationId: session.id,
      source: { objectId: approved.id, objectVersion: approved.graphVersion },
      sensitivity: 'normal',
    });
  }
  return { snapshot, events };
}
