import { describe, expect, it } from 'vitest';
import {
  approveProjectPlanCommand,
  dispatchDepartmentWorkPackageCommand,
  proposeProjectPlanCommand,
} from './projectPlanning';
import { createDepartmentWorkPackage } from '../projectPlanning';
import {
  createEmptyProjectControlSnapshot,
  parseProjectControlSnapshot,
  serializeProjectControlSnapshot,
} from '../persistence';
import { createProjectSession } from '../state';
import type { ProjectPlan } from '../types';

const projectPlan: ProjectPlan = {
  version: 1,
  id: 'project-plan-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  planVersion: 1,
  requirementsRef: { id: 'requirements-1', version: 1 },
  solutionRef: { id: 'solution-1', version: 1 },
  feasibilityRef: { id: 'feasibility-1', version: 1 },
  milestonePlanRef: { id: 'milestones-1', version: 1 },
  departmentCharterRefs: [{ id: 'charter-1', version: 1 }],
  feasibilityStatus: 'feasible',
  blockingQuestionCount: 0,
  approval: 'draft',
  createdAt: '2026-09-12T09:05:00.000Z',
  updatedAt: '2026-09-12T09:05:00.000Z',
};

function projectPlanningSnapshot() {
  const session = createProjectSession({
    id: 'session-1',
    projectId: 'project-1',
    goal: '目标',
    now: '2026-09-01T00:00:00.000Z',
  });
  return {
    ...createEmptyProjectControlSnapshot(),
    activeSessionId: session.id,
    sessions: [session],
  };
}

describe('Project planning command owner', () => {
  it('persists proposal and approval facts, blocks early dispatch, then dispatches an approved package', () => {
    const proposed = proposeProjectPlanCommand({
      snapshot: projectPlanningSnapshot(),
      plan: projectPlan,
      now: '2026-09-12T09:06:00.000Z',
    });
    expect(proposed.snapshot.projectPlans).toEqual([projectPlan]);
    expect(proposed.events.map((event) => event.eventType)).toEqual(['ProjectPlanProposed']);

    const approvedPlan = {
      ...projectPlan,
      approval: 'approved' as const,
      approvedBy: 'user',
      approvedAt: '2026-09-12T09:07:00.000Z',
      updatedAt: '2026-09-12T09:07:00.000Z',
    };
    const packageFromApprovedPlan = createDepartmentWorkPackage({
      plan: approvedPlan,
      id: 'work-package-1',
      departmentCharterId: 'charter-1',
      taskGraphId: 'task-graph-1',
      milestoneIds: ['milestone-1'],
      scope: ['src/feature/**'],
      nonGoals: ['不修改部署'],
      dependencies: [],
      acceptanceCriteria: ['模块测试通过'],
      now: '2026-09-12T09:08:00.000Z',
    });
    expect(() => dispatchDepartmentWorkPackageCommand({
      snapshot: proposed.snapshot,
      workPackage: packageFromApprovedPlan,
      now: '2026-09-12T09:08:00.000Z',
    })).toThrow(/批准/);

    const approved = approveProjectPlanCommand({
      snapshot: proposed.snapshot,
      planId: 'project-plan-1',
      approvedBy: 'user',
      now: '2026-09-12T09:07:00.000Z',
    });
    expect(approved.snapshot.projectPlans?.[0]).toMatchObject({ approval: 'approved' });
    const dispatched = dispatchDepartmentWorkPackageCommand({
      snapshot: approved.snapshot,
      workPackage: packageFromApprovedPlan,
      now: '2026-09-12T09:08:00.000Z',
    });
    expect(dispatched.snapshot.departmentWorkPackages).toEqual([packageFromApprovedPlan]);
    expect(dispatched.events.map((event) => event.eventType)).toEqual(['DepartmentWorkPackageDispatched']);

    const roundTrip = parseProjectControlSnapshot(
      serializeProjectControlSnapshot(dispatched.snapshot),
    );
    expect(roundTrip.projectPlans).toEqual(approved.snapshot.projectPlans);
    expect(roundTrip.departmentWorkPackages).toEqual([packageFromApprovedPlan]);
  });
});