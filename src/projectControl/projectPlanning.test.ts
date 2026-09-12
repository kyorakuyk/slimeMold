import { describe, expect, it } from 'vitest';
import {
  approveProjectPlan,
  createDebateOpinion,
  createDebateRequest,
  createDebateVerdict,
  createDepartmentWorkPackage,
  createProjectPlanDraft,
  reviseProjectPlan,
} from './projectPlanning';

const requirements = {
  version: 1 as const,
  id: 'requirements-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  baselineVersion: 1,
  goal: '交付一个可审计的本地模块',
  scope: ['src/feature/**'],
  nonGoals: ['不发布生产'],
  acceptanceCriteria: ['测试通过'],
  assumptions: ['项目使用 Git'],
  unresolvedQuestions: [],
  createdAt: '2026-09-12T09:00:00.000Z',
};

const solution = {
  version: 1 as const,
  id: 'solution-1',
  projectId: 'project-1',
  requirementsId: 'requirements-1',
  overview: '以隔离模块和宿主验收交付',
  moduleIds: ['module-feature'],
  crossDepartmentContractIds: [],
  createdAt: '2026-09-12T09:01:00.000Z',
};

const feasibility = {
  version: 1 as const,
  id: 'feasibility-1',
  projectId: 'project-1',
  requirementsId: 'requirements-1',
  solutionId: 'solution-1',
  status: 'feasible' as const,
  blockingRisks: [],
  dependencies: [],
  requiredCapabilities: ['typescript'],
  estimatedCostCents: 100,
  estimatedDurationMs: 60_000,
  confidence: 'high' as const,
  createdAt: '2026-09-12T09:02:00.000Z',
};

const milestonePlan = {
  version: 1 as const,
  id: 'milestones-1',
  projectId: 'project-1',
  planVersion: 1,
  milestones: [{
    id: 'milestone-1',
    title: '完成功能模块',
    outcome: '模块可测试',
    dependsOn: [],
    acceptanceCriteria: ['测试通过'],
  }],
  createdAt: '2026-09-12T09:03:00.000Z',
};

const departmentCharter = {
  version: 1 as const,
  id: 'charter-1',
  projectId: 'project-1',
  departmentId: 'department-feature',
  name: '功能交付部门',
  objective: '交付功能模块',
  scope: ['src/feature/**'],
  nonGoals: ['不修改部署'],
  milestoneIds: ['milestone-1'],
  acceptanceCriteria: ['模块测试通过'],
  createdAt: '2026-09-12T09:04:00.000Z',
};

function createDraft() {
  return createProjectPlanDraft({
    id: 'project-plan-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    requirements,
    solution,
    feasibility,
    milestonePlan,
    departmentCharters: [departmentCharter],
    now: '2026-09-12T09:05:00.000Z',
  });
}

describe('Project Delivery Architect planning workflow', () => {
  it('creates a versioned draft with source references and no dispatch authority', () => {
    const draft = createDraft();

    expect(draft).toMatchObject({
      id: 'project-plan-1',
      projectId: 'project-1',
      planVersion: 1,
      approval: 'draft',
      requirementsRef: { id: 'requirements-1', version: 1 },
      solutionRef: { id: 'solution-1', version: 1 },
      feasibilityRef: { id: 'feasibility-1', version: 1 },
      milestonePlanRef: { id: 'milestones-1', version: 1 },
      departmentCharterRefs: [{ id: 'charter-1', version: 1 }],
    });
    expect(() => createDepartmentWorkPackage({
      plan: draft,
      id: 'work-package-1',
      departmentCharterId: 'charter-1',
      taskGraphId: 'task-graph-1',
      milestoneIds: ['milestone-1'],
      scope: ['src/feature/**'],
      nonGoals: ['不修改部署'],
      dependencies: [],
      acceptanceCriteria: ['模块测试通过'],
      now: '2026-09-12T09:06:00.000Z',
    })).toThrow(/批准/);
  });

  it('approves a feasible plan and dispatches only a referenced department package', () => {
    const approved = approveProjectPlan(
      createDraft(),
      'user',
      '2026-09-12T09:07:00.000Z',
    );
    const workPackage = createDepartmentWorkPackage({
      plan: approved,
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

    expect(approved).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(workPackage).toMatchObject({
      id: 'work-package-1',
      planId: 'project-plan-1',
      planVersion: 1,
      departmentCharterId: 'charter-1',
      taskGraphId: 'task-graph-1',
      status: 'dispatched',
    });
  });

  it('keeps infeasible or unresolved plans from being approved', () => {
    const infeasible = createProjectPlanDraft({
      id: 'project-plan-infeasible',
      projectId: 'project-1',
      sessionId: 'session-1',
      requirements: { ...requirements, unresolvedQuestions: ['是否需要云同步？'] },
      solution,
      feasibility: { ...feasibility, status: 'infeasible', blockingRisks: ['缺少运行环境'] },
      milestonePlan,
      departmentCharters: [departmentCharter],
      now: '2026-09-12T09:05:00.000Z',
    });

    expect(() => approveProjectPlan(
      infeasible,
      'user',
      '2026-09-12T09:07:00.000Z',
    )).toThrow(/可行|问题/);
  });
});

describe('ProjectPlan revisions and planning review', () => {
  it('creates a new plan revision without mutating the previous plan', () => {
    const original = createDraft();
    const revised = reviseProjectPlan({
      plan: original,
      id: 'project-plan-2',
      now: '2026-09-12T09:09:00.000Z',
      blockingQuestionCount: 1,
    });

    expect(original).toMatchObject({ id: 'project-plan-1', planVersion: 1, approval: 'draft' });
    expect(revised).toMatchObject({
      id: 'project-plan-2',
      revisionOf: 'project-plan-1',
      planVersion: 2,
      approval: 'draft',
      blockingQuestionCount: 1,
    });
  });

  it('freezes debate evidence and preserves minority opinions in the verdict', () => {
    const request = createDebateRequest({
      id: 'debate-1',
      projectId: 'project-1',
      planId: 'project-plan-1',
      question: '是否保留兼容层？',
      evidencePackRefs: [{ id: 'evidence-1', version: 1 }],
      maxRounds: 2,
      maxModels: 3,
      maxTokens: 4_000,
      maxMoneyCents: 200,
      now: '2026-09-12T09:10:00.000Z',
    });
    const first = createDebateOpinion({
      request,
      id: 'opinion-1',
      role: 'solution-architect',
      proposal: '保留兼容层',
      assumptions: ['旧项目仍需打开'],
      risks: ['维护成本增加'],
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      confidence: 'high',
      now: '2026-09-12T09:11:00.000Z',
    });
    const second = createDebateOpinion({
      request,
      id: 'opinion-2',
      role: 'risk-reviewer',
      proposal: '移除兼容层',
      assumptions: ['迁移可以一次完成'],
      risks: ['旧项目无法打开'],
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      confidence: 'medium',
      now: '2026-09-12T09:12:00.000Z',
    });
    const verdict = createDebateVerdict({
      request,
      id: 'verdict-1',
      opinions: [first, second],
      recommendation: '保留兼容层',
      minorityOpinions: ['移除兼容层'],
      unresolvedQuestions: ['何时移除兼容层？'],
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      now: '2026-09-12T09:13:00.000Z',
    });

    expect(request).toMatchObject({ maxRounds: 2, maxModels: 3, maxTokens: 4_000 });
    expect(verdict).toMatchObject({
      debateId: 'debate-1',
      status: 'draft',
      minorityOpinions: ['移除兼容层'],
      opinionRefs: [
        { id: 'opinion-1', version: 1 },
        { id: 'opinion-2', version: 1 },
      ],
    });
    expect(() => createDebateOpinion({
      request,
      id: 'opinion-out-of-pack',
      role: 'unknown-reviewer',
      proposal: '使用未冻结证据',
      assumptions: [],
      risks: [],
      evidenceRefs: [{ id: 'evidence-2', version: 1 }],
      confidence: 'low',
      now: '2026-09-12T09:14:00.000Z',
    })).toThrow(/Evidence|evidence|冻结/);
  });
});
