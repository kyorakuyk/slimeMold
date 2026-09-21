import { appendDomainEvent, type DomainEvent } from '../domain/contracts';
import {
  createEmptyProjectControlSnapshot,
} from './persistence';
import type {
  DepartmentWorkPackage,
  ProjectControlSnapshot,
  ProjectIssue,
  ProjectIssueStatus,
  ProjectPlan,
} from './types';
import type { Orchestration } from '../types/orchestration';
import { createIssue, transitionIssue } from './issue';
import {
  approveArchitecture,
  approveBrief,
  createProjectSession,
  transitionSession,
} from './state';
import { applyMasterTurn, type ApplyMasterTurnInput } from './session';
import { approveTaskGraph, createTaskGraphFromArchitecture, reviseTaskGraph } from './taskGraph';
import { approveProjectPlan } from './projectPlanning';
import { materializeTaskIssues, taskIssueId } from './taskGraphProjection';

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

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function appendFact(
  events: DomainEvent[],
  event: Omit<DomainEvent, 'sequence' | 'aggregateVersion'>,
): void {
  const previous = [...events]
    .reverse()
    .find((item) => item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId);
  const next: DomainEvent = {
    ...event,
    sequence: events.length + 1,
    aggregateVersion: (previous?.aggregateVersion ?? 0) + 1,
  };
  events.splice(0, events.length, ...appendDomainEvent(events, next));
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

export interface CreateIssueCommandInput {
  snapshot: ProjectControlSnapshot;
  issue: ProjectIssue;
  /** 当前项目的 event stream；允许 issue.projectId 为 null 表示未分配。 */
  projectId?: string;
  now: string;
  actor?: DomainEvent['actor'];
}

export function createIssueCommand(input: CreateIssueCommandInput): ProjectControlCommandResult {
  const issueId = requiredText(input.issue.id, 'Issue id');
  const now = requiredText(input.now, '时间');
  if (input.snapshot.issues.some((item) => item.id === issueId)) {
    throw new Error(`Issue 已存在：${issueId}`);
  }
  if (input.projectId && input.issue.projectId && input.projectId !== input.issue.projectId) {
    throw new Error(`Issue 不属于当前项目：${issueId}`);
  }
  const issue = {
    ...input.issue,
    relatedTaskIds: [...input.issue.relatedTaskIds],
  };
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: [issue, ...input.snapshot.issues],
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${issueId}:created`,
    streamId: input.projectId ?? issue.projectId ?? `issue:${issueId}`,
    aggregateType: 'Issue',
    aggregateId: issueId,
    eventType: 'IssueCreated',
    schemaVersion: 1,
    payload: {
      issueId,
      projectId: issue.projectId,
      title: issue.title,
      description: issue.description,
      sourceSessionId: issue.sourceSessionId,
      issueType: issue.type,
      status: issue.status,
      relatedTaskIds: [...issue.relatedTaskIds],
    },
    actor: input.actor ?? 'user',
    occurredAt: now,
    correlationId: issue.sourceSessionId ?? issueId,
    source: { objectId: issueId, objectVersion: issue.version },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}

export interface TransitionIssueCommandInput {
  snapshot: ProjectControlSnapshot;
  projectId?: string;
  issueId: string;
  status: ProjectIssueStatus;
  now: string;
  actor?: DomainEvent['actor'];
}

export function transitionIssueCommand(
  input: TransitionIssueCommandInput,
): ProjectControlCommandResult {
  const issue = input.snapshot.issues.find((item) => item.id === input.issueId);
  if (!issue) throw new Error(`Issue 不存在：${input.issueId}`);
  if (input.projectId && issue.projectId && issue.projectId !== input.projectId) {
    throw new Error(`Issue 不属于当前项目：${input.issueId}`);
  }
  const nextIssue = transitionIssue(issue, input.status, input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: input.snapshot.issues.map((item) => (item.id === issue.id ? nextIssue : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${issue.id}:status:${input.now}:${nextIssue.status}`,
    streamId: input.projectId ?? issue.projectId ?? `issue:${issue.id}`,
    aggregateType: 'Issue',
    aggregateId: issue.id,
    eventType: 'IssueStatusChanged',
    schemaVersion: 1,
    payload: {
      issueId: issue.id,
      projectId: issue.projectId,
      from: issue.status,
      to: nextIssue.status,
      relatedTaskIds: [...issue.relatedTaskIds],
    },
    actor: input.actor ?? 'user',
    occurredAt: input.now,
    correlationId: issue.sourceSessionId ?? issue.id,
    source: { objectId: issue.id, objectVersion: nextIssue.version },
    sensitivity: 'normal',
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

export interface ProjectControlCommandResult {
  snapshot: ProjectControlSnapshot;
  events: DomainEvent[];
}

export interface ProposeProjectPlanCommandInput {
  snapshot: ProjectControlSnapshot;
  plan: ProjectPlan;
  now: string;
}

export function proposeProjectPlanCommand(
  input: ProposeProjectPlanCommandInput,
): ProjectControlCommandResult {
  const plan = input.plan;
  const session = input.snapshot.sessions.find((item) => item.id === plan.sessionId);
  if (!session) throw new Error(`项目会话不存在：${plan.sessionId}`);
  if (session.projectId !== plan.projectId) throw new Error('项目计划不属于当前会话项目');
  if (plan.approval !== 'draft') throw new Error(`项目计划不能作为草案提案：${plan.approval}`);
  if (input.snapshot.projectPlans?.some((item) => item.id === plan.id)) {
    throw new Error(`项目计划已存在：${plan.id}`);
  }
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    projectPlans: [...(input.snapshot.projectPlans ?? []), {
      ...plan,
      departmentCharterRefs: plan.departmentCharterRefs.map((reference) => ({ ...reference })),
    }],
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${plan.id}:proposed`,
    streamId: plan.projectId,
    aggregateType: 'ProjectPlan',
    aggregateId: plan.id,
    eventType: 'ProjectPlanProposed',
    schemaVersion: 1,
    payload: {
      projectPlanId: plan.id,
      sessionId: plan.sessionId,
      planVersion: plan.planVersion,
      requirementsRef: plan.requirementsRef,
      solutionRef: plan.solutionRef,
      feasibilityRef: plan.feasibilityRef,
      milestonePlanRef: plan.milestonePlanRef,
      departmentCharterRefs: plan.departmentCharterRefs,
    },
    actor: 'master',
    occurredAt: input.now,
    correlationId: plan.sessionId,
    source: { objectId: plan.id, objectVersion: plan.planVersion },
    sensitivity: 'private',
  });
  return { snapshot, events };
}

export interface ApproveProjectPlanCommandInput {
  snapshot: ProjectControlSnapshot;
  planId: string;
  approvedBy: string;
  now: string;
}

export function approveProjectPlanCommand(
  input: ApproveProjectPlanCommandInput,
): ProjectControlCommandResult {
  const plan = input.snapshot.projectPlans?.find((item) => item.id === input.planId);
  if (!plan) throw new Error(`项目计划不存在：${input.planId}`);
  const approved = approveProjectPlan(plan, input.approvedBy, input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    projectPlans: (input.snapshot.projectPlans ?? []).map((item) =>
      item.id === approved.id ? approved : item,
    ),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${approved.id}:approved:${approved.approvedAt ?? input.now}`,
    streamId: approved.projectId,
    aggregateType: 'ProjectPlan',
    aggregateId: approved.id,
    eventType: 'ProjectPlanApproved',
    schemaVersion: 1,
    payload: {
      projectPlanId: approved.id,
      sessionId: approved.sessionId,
      planVersion: approved.planVersion,
      approvedBy: approved.approvedBy,
    },
    actor: 'user',
    occurredAt: input.now,
    correlationId: approved.sessionId,
    source: { objectId: approved.id, objectVersion: approved.planVersion },
    sensitivity: 'private',
  });
  return { snapshot, events };
}

export interface DispatchDepartmentWorkPackageCommandInput {
  snapshot: ProjectControlSnapshot;
  workPackage: DepartmentWorkPackage;
  now: string;
}

export function dispatchDepartmentWorkPackageCommand(
  input: DispatchDepartmentWorkPackageCommandInput,
): ProjectControlCommandResult {
  const workPackage = input.workPackage;
  const plan = input.snapshot.projectPlans?.find((item) => item.id === workPackage.planId);
  if (!plan) throw new Error(`项目计划不存在：${workPackage.planId}`);
  if (plan.approval !== 'approved') {
    throw new Error(`项目计划尚未批准，不能下发部门 Work Package：${plan.approval}`);
  }
  if (workPackage.projectId !== plan.projectId) throw new Error('Work Package 不属于项目计划');
  if (workPackage.planVersion !== plan.planVersion) throw new Error('Work Package 的计划版本已漂移');
  if (workPackage.status !== 'dispatched') throw new Error(`Work Package 状态不可下发：${workPackage.status}`);
  if (input.snapshot.departmentWorkPackages?.some((item) => item.id === workPackage.id)) {
    throw new Error(`Work Package 已存在：${workPackage.id}`);
  }
  const persisted: DepartmentWorkPackage = {
    ...workPackage,
    milestoneIds: [...workPackage.milestoneIds],
    scope: [...workPackage.scope],
    nonGoals: [...workPackage.nonGoals],
    dependencies: [...workPackage.dependencies],
    acceptanceCriteria: [...workPackage.acceptanceCriteria],
  };
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    departmentWorkPackages: [
      ...(input.snapshot.departmentWorkPackages ?? []),
      persisted,
    ],
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${persisted.id}:dispatched`,
    streamId: persisted.projectId,
    aggregateType: 'DepartmentWorkPackage',
    aggregateId: persisted.id,
    eventType: 'DepartmentWorkPackageDispatched',
    schemaVersion: 1,
    payload: {
      workPackageId: persisted.id,
      planId: persisted.planId,
      planVersion: persisted.planVersion,
      departmentCharterId: persisted.departmentCharterId,
      taskGraphId: persisted.taskGraphId,
      milestoneIds: persisted.milestoneIds,
    },
    actor: 'master',
    occurredAt: input.now,
    correlationId: persisted.planId,
    source: { objectId: persisted.planId, objectVersion: persisted.planVersion },
    sensitivity: 'private',
  });
  return { snapshot, events };
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

/** Apply a master turn and expose the same state transition as auditable facts. */
export function applyMasterTurnCommand(
  input: ApplyMasterTurnInput,
): ProjectControlCommandResult {
  const before = input.snapshot.sessions.find((session) => session.id === input.sessionId);
  if (!before) throw new Error(`项目会话不存在：${input.sessionId}`);
  const snapshot = applyMasterTurn(input);
  const after = snapshot.sessions.find((session) => session.id === input.sessionId);
  if (!after) throw new Error(`主控回合后会话丢失：${input.sessionId}`);

  const events: DomainEvent[] = [];
  const newMessages = after.messages.filter(
    (message) => !before.messages.some((existing) => existing.id === message.id),
  );
  for (const message of newMessages) {
    appendFact(events, {
      eventId: `${message.id}:recorded`,
      streamId: after.projectId,
      aggregateType: 'Session',
      aggregateId: after.id,
      eventType: 'SessionMessageRecorded',
      schemaVersion: 1,
      payload: {
        sessionId: after.id,
        messageId: message.id,
        role: message.role,
        content: message.content,
      },
      actor: message.role === 'user' ? 'user' : 'master',
      occurredAt: message.createdAt,
      correlationId: after.id,
      source: { objectId: after.id, objectVersion: 1 },
      sensitivity: 'private',
    });
  }

  const responsePayload =
    input.response.kind === 'question'
      ? {
          responseKind: input.response.kind,
          questionIds: input.response.questions.map((question) => question.id),
        }
      : input.response.kind === 'brief'
        ? { responseKind: input.response.kind, briefId: after.briefId ?? null }
        : { responseKind: input.response.kind, architectureId: after.architectureId ?? null };
  appendFact(events, {
    eventId: `${after.id}:master-turn:${after.messages.at(-1)?.id ?? input.now}`,
    streamId: after.projectId,
    aggregateType: 'Session',
    aggregateId: after.id,
    eventType: 'MasterTurnCompleted',
    schemaVersion: 1,
    payload: { sessionId: after.id, ...responsePayload },
    actor: 'master',
    occurredAt: input.now,
    correlationId: after.id,
    source: { objectId: after.id, objectVersion: 1 },
    sensitivity: 'private',
  });

  if (input.response.kind === 'brief' && after.briefId) {
    const brief = snapshot.briefs.find((item) => item.id === after.briefId);
    if (brief) {
      appendFact(events, {
        eventId: `${brief.id}:proposed`,
        streamId: after.projectId,
        aggregateType: 'Brief',
        aggregateId: brief.id,
        eventType: 'BriefProposed',
        schemaVersion: 1,
        payload: { briefId: brief.id, sessionId: after.id, briefVersion: brief.briefVersion },
        actor: 'master',
        occurredAt: brief.createdAt,
        correlationId: after.id,
        source: { objectId: brief.id, objectVersion: brief.briefVersion },
        sensitivity: 'private',
      });
    }
  }
  if (input.response.kind === 'architecture' && after.architectureId) {
    const architecture = snapshot.architectures.find((item) => item.id === after.architectureId);
    if (architecture) {
      appendFact(events, {
        eventId: `${architecture.id}:proposed`,
        streamId: after.projectId,
        aggregateType: 'Architecture',
        aggregateId: architecture.id,
        eventType: 'ArchitectureProposed',
        schemaVersion: 1,
        payload: {
          architectureId: architecture.id,
          sessionId: after.id,
          briefId: architecture.briefId,
          architectureVersion: architecture.architectureVersion,
        },
        actor: 'master',
        occurredAt: architecture.createdAt,
        correlationId: after.id,
        source: { objectId: architecture.id, objectVersion: architecture.architectureVersion },
        sensitivity: 'private',
      });
    }
  }

  return { snapshot, events };
}
