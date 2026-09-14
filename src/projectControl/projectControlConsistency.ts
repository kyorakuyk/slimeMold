import { replayDomainEvents, type DomainEvent } from '../domain/contracts';
import type {
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectIssue,
  ProjectPlan,
  ProjectSession,
  ProjectTaskGraph,
  DepartmentWorkPackage,
} from './types';

export type ProjectControlConsistencyIssueCode =
  | 'invalid-event-stream'
  | 'event-stream-project-mismatch'
  | 'missing-project-event'
  | 'project-count-drift'
  | 'missing-session-event'
  | 'session-project-drift'
  | 'session-status-drift'
  | 'session-link-drift'
  | 'missing-issue-event'
  | 'issue-project-drift'
  | 'issue-status-drift'
  | 'missing-brief-event'
  | 'brief-version-drift'
  | 'brief-approval-drift'
  | 'missing-architecture-event'
  | 'architecture-version-drift'
  | 'architecture-approval-drift'
  | 'missing-task-graph-event'
  | 'task-graph-version-drift'
  | 'task-graph-approval-drift'
  | 'missing-project-plan-event'
  | 'project-plan-version-drift'
  | 'project-plan-approval-drift'
  | 'missing-work-package-event'
  | 'work-package-version-drift'
  | 'work-package-plan-drift'
  | 'missing-decision-event'
  | 'orphaned-control-event';

export interface ProjectControlConsistencyIssue {
  code: ProjectControlConsistencyIssueCode;
  message: string;
  aggregateType?: string;
  aggregateId?: string;
}

export interface ProjectControlConsistencyReport {
  ok: boolean;
  lastSequence: number;
  recognizedEventCount: number;
  issues: ProjectControlConsistencyIssue[];
}

const recognized = new Set([
  'ProjectCreated', 'ProjectControlBaselineImported',
  'SessionStarted', 'LegacySessionImported', 'SessionMessageRecorded',
  'MasterTurnCompleted', 'SessionStatusChanged', 'SessionOrchestrationLinked', 'SessionTaskGraphLinked',
  'BriefProposed', 'LegacyBriefImported', 'BriefApproved',
  'ArchitectureProposed', 'LegacyArchitectureImported', 'ArchitectureApproved',
  'TaskGraphProposed', 'TaskGraphRevisionCreated', 'TaskGraphSuperseded', 'LegacyTaskGraphImported', 'TaskGraphApproved', 'LegacyTaskImported',
  'ProjectPlanProposed', 'ProjectPlanApproved', 'DepartmentWorkPackageDispatched',
  'IssueStatusChanged', 'LegacyIssueImported', 'IssueCreated', 'LegacyDecisionImported',
]);

function objectPayload(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function add(
  issues: ProjectControlConsistencyIssue[],
  code: ProjectControlConsistencyIssueCode,
  message: string,
  aggregateType?: string,
  aggregateId?: string,
): void {
  issues.push({ code, message, ...(aggregateType ? { aggregateType } : {}), ...(aggregateId ? { aggregateId } : {}) });
}

function aggregate(events: readonly DomainEvent[], type: string, id: string): DomainEvent[] {
  return events.filter((event) => event.aggregateType === type && event.aggregateId === id);
}

function last(events: readonly DomainEvent[], type: string): DomainEvent | undefined {
  return [...events].reverse().find((event) => event.eventType === type);
}

function has(events: readonly DomainEvent[], types: readonly string[]): boolean {
  return events.some((event) => types.includes(event.eventType));
}

function compareSession(
  session: ProjectSession,
  events: readonly DomainEvent[],
  issues: ProjectControlConsistencyIssue[],
): void {
  const facts = aggregate(events, 'Session', session.id);
  if (!has(facts, ['SessionStarted', 'LegacySessionImported'])) {
    add(issues, 'missing-session-event', `ProjectFile Session 缺少 durable fact：${session.id}`, 'Session', session.id);
    return;
  }
  const started = last(facts, 'SessionStarted');
  if (started && objectPayload(started.payload).projectId !== session.projectId) {
    add(issues, 'session-project-drift', `Session projectId 与事件不一致：${session.id}`, 'Session', session.id);
  }
  const imported = last(facts, 'LegacySessionImported');
  if (imported && objectPayload(imported.payload).status !== session.status) {
    add(issues, 'session-status-drift', `Session 状态与 legacy fact 不一致：${session.id}`, 'Session', session.id);
  }
  const status = last(facts, 'SessionStatusChanged');
  if (status && objectPayload(status.payload).to !== session.status) {
    add(issues, 'session-status-drift', `Session 状态与事件不一致：${session.id}`, 'Session', session.id);
  }
  if (started && !imported && !status && session.status !== 'clarifying') {
    add(issues, 'session-status-drift', `Session 初始状态与 SessionStarted 语义不一致：${session.id}`, 'Session', session.id);
  }
  const links = [last(facts, 'SessionOrchestrationLinked'), last(facts, 'SessionTaskGraphLinked')].filter(Boolean) as DomainEvent[];
  const linkMismatch = links.some((event) => {
    const payload = objectPayload(event.payload);
    return event.eventType === 'SessionOrchestrationLinked'
      ? payload.orchestrationId !== session.orchestrationId
      : payload.taskGraphId !== session.taskGraphId;
  });
  if (linkMismatch) add(issues, 'session-link-drift', `Session 关联对象与事件不一致：${session.id}`, 'Session', session.id);
}

function compareVersioned(
  item: ProjectBrief | ProjectArchitecture | ProjectTaskGraph,
  events: readonly DomainEvent[],
  issues: ProjectControlConsistencyIssue[],
  config: {
    aggregateType: 'Brief' | 'Architecture' | 'TaskGraph';
    normalProposal: string | readonly string[];
    legacyImport: string;
    approvalEvent: string;
    versionKey: 'briefVersion' | 'architectureVersion' | 'graphVersion';
    version: number;
    approval: string;
    missingCode: ProjectControlConsistencyIssueCode;
    versionCode: ProjectControlConsistencyIssueCode;
    approvalCode: ProjectControlConsistencyIssueCode;
  },
): void {
  const facts = aggregate(events, config.aggregateType, item.id);
  const proposalEvents = Array.isArray(config.normalProposal) ? config.normalProposal : [config.normalProposal];
  if (!has(facts, [...proposalEvents, config.legacyImport])) {
    add(issues, config.missingCode, `ProjectFile ${config.aggregateType} 缺少 durable fact：${item.id}`, config.aggregateType, item.id);
    return;
  }
  const versionEvent = [...facts].reverse().find((event) => proposalEvents.includes(event.eventType))
    ?? last(facts, config.legacyImport);
  const eventVersion = objectPayload(versionEvent?.payload)[config.versionKey];
  if (typeof eventVersion === 'number' && eventVersion !== config.version) {
    add(issues, config.versionCode, `${config.aggregateType} 版本与事件不一致：${item.id}`, config.aggregateType, item.id);
  }
  const imported = last(facts, config.legacyImport);
  if (imported && objectPayload(imported.payload).approval !== config.approval) {
    add(issues, config.approvalCode, `${config.aggregateType} 审批状态与 legacy fact 不一致：${item.id}`, config.aggregateType, item.id);
  }
  const approvalFact = last(facts, config.approvalEvent);
  if (config.approval === 'approved' && !approvalFact) {
    add(issues, config.approvalCode, `${config.aggregateType} 已批准但缺少批准事实：${item.id}`, config.aggregateType, item.id);
  }
  if (approvalFact && config.approval !== 'approved' && config.approval !== 'superseded') {
    add(issues, config.approvalCode, `${config.aggregateType} 有批准事实但 ProjectFile 未批准：${item.id}`, config.aggregateType, item.id);
  }
}

function compareIssue(
  projectIssue: ProjectIssue,
  events: readonly DomainEvent[],
  issues: ProjectControlConsistencyIssue[],
): void {
  const facts = aggregate(events, 'Issue', projectIssue.id);
  if (!has(facts, ['IssueCreated', 'LegacyIssueImported'])) {
    add(issues, 'missing-issue-event', `ProjectFile Issue 缺少 durable fact：${projectIssue.id}`, 'Issue', projectIssue.id);
    return;
  }
  const created = last(facts, 'IssueCreated');
  if (created && objectPayload(created.payload).projectId !== projectIssue.projectId) {
    add(issues, 'issue-project-drift', `Issue projectId 与事件不一致：${projectIssue.id}`, 'Issue', projectIssue.id);
  }
  const status = last(facts, 'IssueStatusChanged');
  if (status && objectPayload(status.payload).to !== projectIssue.status) {
    add(issues, 'issue-status-drift', `Issue 状态与事件不一致：${projectIssue.id}`, 'Issue', projectIssue.id);
  }
  const imported = last(facts, 'LegacyIssueImported');
  if (imported) {
    const payload = objectPayload(imported.payload);
    if (payload.projectId !== projectIssue.projectId || payload.status !== projectIssue.status) {
      add(issues, 'issue-status-drift', `Issue 状态或项目归属与 legacy fact 不一致：${projectIssue.id}`, 'Issue', projectIssue.id);
    }
  }
}

function compareProjectPlan(
  plan: ProjectPlan,
  events: readonly DomainEvent[],
  issues: ProjectControlConsistencyIssue[],
): void {
  const facts = aggregate(events, 'ProjectPlan', plan.id);
  if (!has(facts, ['ProjectPlanProposed'])) {
    add(issues, 'missing-project-plan-event', `ProjectFile ProjectPlan 缺少 durable fact：${plan.id}`, 'ProjectPlan', plan.id);
    return;
  }
  const proposed = last(facts, 'ProjectPlanProposed');
  const eventVersion = objectPayload(proposed?.payload).planVersion;
  if (typeof eventVersion === 'number' && eventVersion !== plan.planVersion) {
    add(issues, 'project-plan-version-drift', `ProjectPlan 版本与事件不一致：${plan.id}`, 'ProjectPlan', plan.id);
  }
  const approved = last(facts, 'ProjectPlanApproved');
  if (plan.approval === 'approved' && !approved) {
    add(issues, 'project-plan-approval-drift', `ProjectPlan 已批准但缺少批准事实：${plan.id}`, 'ProjectPlan', plan.id);
  }
  if (plan.approval !== 'approved' && approved) {
    add(issues, 'project-plan-approval-drift', `ProjectPlan 审批状态与事件不一致：${plan.id}`, 'ProjectPlan', plan.id);
  }
}

function compareDepartmentWorkPackage(
  workPackage: DepartmentWorkPackage,
  plans: readonly ProjectPlan[],
  events: readonly DomainEvent[],
  issues: ProjectControlConsistencyIssue[],
): void {
  const facts = aggregate(events, 'DepartmentWorkPackage', workPackage.id);
  if (!has(facts, ['DepartmentWorkPackageDispatched'])) {
    add(issues, 'missing-work-package-event', `ProjectFile Work Package 缺少 durable fact：${workPackage.id}`, 'DepartmentWorkPackage', workPackage.id);
    return;
  }
  const plan = plans.find((item) => item.id === workPackage.planId);
  if (!plan || plan.projectId !== workPackage.projectId) {
    add(issues, 'work-package-plan-drift', `Work Package 的项目计划不存在或项目不一致：${workPackage.id}`, 'DepartmentWorkPackage', workPackage.id);
  } else if (plan.planVersion !== workPackage.planVersion) {
    add(issues, 'work-package-version-drift', `Work Package 计划版本与 ProjectPlan 不一致：${workPackage.id}`, 'DepartmentWorkPackage', workPackage.id);
  }
  const dispatched = last(facts, 'DepartmentWorkPackageDispatched');
  const eventVersion = objectPayload(dispatched?.payload).planVersion;
  if (typeof eventVersion === 'number' && eventVersion !== workPackage.planVersion) {
    add(issues, 'work-package-version-drift', `Work Package 版本与事件不一致：${workPackage.id}`, 'DepartmentWorkPackage', workPackage.id);
  }
}

/** Audit structured control state without pretending summary events contain full private objects. */
export function auditProjectControlConsistency(input: {
  projectId: string;
  snapshot: ProjectControlSnapshot;
  events: readonly DomainEvent[];
}): ProjectControlConsistencyReport {
  const issues: ProjectControlConsistencyIssue[] = [];
  const events = input.events.filter((event) => event.streamId === input.projectId);
  if (events.length !== input.events.length) add(issues, 'event-stream-project-mismatch', '事件流包含不属于当前项目的控制面事实');

  try {
    const projection = replayDomainEvents(events);
    const projectFacts = aggregate(events, 'Project', input.projectId);
    if (!has(projectFacts, ['ProjectCreated', 'ProjectControlBaselineImported'])) {
      add(issues, 'missing-project-event', `项目缺少 durable fact：${input.projectId}`, 'Project', input.projectId);
    }
    const baseline = last(projectFacts, 'ProjectControlBaselineImported');
    if (baseline) {
      const counts = objectPayload(objectPayload(baseline.payload).counts);
      const actual = {
        sessions: input.snapshot.sessions.length,
        decisions: input.snapshot.decisions.length,
        briefs: input.snapshot.briefs.length,
        architectures: input.snapshot.architectures.length,
        issues: input.snapshot.issues.length,
        taskGraphs: input.snapshot.taskGraphs?.length ?? 0,
        projectPlans: input.snapshot.projectPlans?.length ?? 0,
        departmentWorkPackages: input.snapshot.departmentWorkPackages?.length ?? 0,
      };
      for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
        if (typeof counts[key] === 'number' && counts[key] !== actual[key]) add(issues, 'project-count-drift', `synthetic baseline 数量与 ProjectFile 不一致：${key}`, 'Project', input.projectId);
      }
    }

    for (const item of input.snapshot.sessions) compareSession(item, events, issues);
    for (const item of input.snapshot.briefs) compareVersioned(item, events, issues, {
      aggregateType: 'Brief', normalProposal: 'BriefProposed', legacyImport: 'LegacyBriefImported', approvalEvent: 'BriefApproved', versionKey: 'briefVersion', version: item.briefVersion, approval: item.approval,
      missingCode: 'missing-brief-event', versionCode: 'brief-version-drift', approvalCode: 'brief-approval-drift',
    });
    for (const item of input.snapshot.architectures) compareVersioned(item, events, issues, {
      aggregateType: 'Architecture', normalProposal: 'ArchitectureProposed', legacyImport: 'LegacyArchitectureImported', approvalEvent: 'ArchitectureApproved', versionKey: 'architectureVersion', version: item.architectureVersion, approval: item.approval,
      missingCode: 'missing-architecture-event', versionCode: 'architecture-version-drift', approvalCode: 'architecture-approval-drift',
    });
    for (const item of input.snapshot.taskGraphs ?? []) compareVersioned(item, events, issues, {
      aggregateType: 'TaskGraph', normalProposal: ['TaskGraphProposed', 'TaskGraphRevisionCreated'], legacyImport: 'LegacyTaskGraphImported', approvalEvent: 'TaskGraphApproved', versionKey: 'graphVersion', version: item.graphVersion, approval: item.approval,
      missingCode: 'missing-task-graph-event', versionCode: 'task-graph-version-drift', approvalCode: 'task-graph-approval-drift',
    });
    for (const item of input.snapshot.projectPlans ?? []) compareProjectPlan(item, events, issues);
    for (const item of input.snapshot.departmentWorkPackages ?? []) compareDepartmentWorkPackage(
      item,
      input.snapshot.projectPlans ?? [],
      events,
      issues,
    );
    for (const item of input.snapshot.issues) compareIssue(item, events, issues);
    for (const item of input.snapshot.decisions) {
      if (!has(aggregate(events, 'Decision', item.id), ['LegacyDecisionImported'])) add(issues, 'missing-decision-event', `ProjectFile Decision 缺少 durable fact：${item.id}`, 'Decision', item.id);
    }

    const known = new Set([
      ...input.snapshot.sessions.map((item) => `Session/${item.id}`),
      ...input.snapshot.briefs.map((item) => `Brief/${item.id}`),
      ...input.snapshot.architectures.map((item) => `Architecture/${item.id}`),
      ...(input.snapshot.taskGraphs ?? []).map((item) => `TaskGraph/${item.id}`),
      ...(input.snapshot.projectPlans ?? []).map((item) => `ProjectPlan/${item.id}`),
      ...(input.snapshot.departmentWorkPackages ?? []).map((item) => `DepartmentWorkPackage/${item.id}`),
      ...input.snapshot.issues.map((item) => `Issue/${item.id}`),
      ...input.snapshot.decisions.map((item) => `Decision/${item.id}`),
      `Project/${input.projectId}`,
    ]);
    for (const event of events) {
      if (!recognized.has(event.eventType)) continue;
      const key = `${event.aggregateType}/${event.aggregateId}`;
      if (!known.has(key) && event.aggregateType !== 'Task') add(issues, 'orphaned-control-event', `事件流存在 ProjectFile 未登记的控制面事实：${key}`, event.aggregateType, event.aggregateId);
    }
    return {
      ok: issues.length === 0,
      lastSequence: projection.lastSequence,
      recognizedEventCount: events.filter((event) => recognized.has(event.eventType)).length,
      issues,
    };
  } catch (cause) {
    add(issues, 'invalid-event-stream', `控制面事件流无法重放：${cause instanceof Error ? cause.message : String(cause)}`);
    return { ok: false, lastSequence: 0, recognizedEventCount: 0, issues };
  }
}
