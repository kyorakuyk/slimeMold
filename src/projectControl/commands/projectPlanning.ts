import type { DomainEvent } from '../../domain/contracts';
import type {
  DepartmentWorkPackage,
  ProjectControlSnapshot,
  ProjectPlan,
} from '../types';
import { approveProjectPlan } from '../projectPlanning';
import { appendFact, type ProjectControlCommandResult } from './shared';

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
