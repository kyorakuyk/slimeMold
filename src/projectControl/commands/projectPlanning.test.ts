import { describe, expect, it } from 'vitest';
import {
  approveProjectPlanCommand,
  dispatchDepartmentWorkPackageCommand,
  proposeProjectPlanCommand,
} from './projectPlanning';
import { createDepartmentWorkPackage } from '../projectPlanning';
import { parseProjectControlSnapshot, serializeProjectControlSnapshot } from '../persistence';
import { architectureSnapshot, projectPlan } from '../commands.testFixtures';

describe('Project planning command owner', () => {
  it('persists proposal and approval facts, blocks early dispatch, then dispatches an approved package', () => {
    const proposed = proposeProjectPlanCommand({
      snapshot: architectureSnapshot(),
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