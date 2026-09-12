import type {
  DebateOpinion,
  DebateRequest,
  DebateVerdict,
  DepartmentCharter,
  DepartmentWorkPackage,
  FeasibilityAssessment,
  MilestonePlan,
  PlanningConfidence,
  PlanningReference,
  ProjectPlan,
  RequirementsBaseline,
  SolutionOutline,
} from './types';

export interface CreateProjectPlanDraftInput {
  id: string;
  projectId: string;
  sessionId: string;
  requirements: RequirementsBaseline;
  solution: SolutionOutline;
  feasibility: FeasibilityAssessment;
  milestonePlan: MilestonePlan;
  departmentCharters: readonly DepartmentCharter[];
  now: string;
}

export interface CreateDepartmentWorkPackageInput {
  plan: ProjectPlan;
  id: string;
  departmentCharterId: string;
  taskGraphId: string;
  milestoneIds: readonly string[];
  scope: readonly string[];
  nonGoals: readonly string[];
  dependencies: readonly string[];
  acceptanceCriteria: readonly string[];
  now: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function requireVersionOne(value: number, field: string): void {
  if (value !== 1) throw new Error(`${field} 只支持 v1`);
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负安全整数`);
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} 必须是大于 0 的安全整数`);
  }
}

function copyTexts(values: readonly string[], field: string): string[] {
  return values.map((value, index) => requiredText(value, `${field}[${index}]`));
}

function requireSameProject(projectId: string, sourceProjectId: string, field: string): void {
  if (projectId !== sourceProjectId) {
    throw new Error(`${field} 不属于当前 project`);
  }
}

function requireReferenceId(id: string, refs: readonly { id: string }[], field: string): void {
  if (!refs.some((reference) => reference.id === id)) {
    throw new Error(`${field} 未被当前计划引用：${id}`);
  }
}

function validatePlanningSources(input: CreateProjectPlanDraftInput): void {
  requireVersionOne(input.requirements.version, 'requirements.version');
  requireVersionOne(input.solution.version, 'solution.version');
  requireVersionOne(input.feasibility.version, 'feasibility.version');
  requireVersionOne(input.milestonePlan.version, 'milestonePlan.version');
  input.departmentCharters.forEach((charter, index) => {
    requireVersionOne(charter.version, `departmentCharters[${index}].version`);
  });

  requireSameProject(input.projectId, input.requirements.projectId, 'requirements');
  requireSameProject(input.projectId, input.solution.projectId, 'solution');
  requireSameProject(input.projectId, input.feasibility.projectId, 'feasibility');
  requireSameProject(input.projectId, input.milestonePlan.projectId, 'milestonePlan');
  input.departmentCharters.forEach((charter) => {
    requireSameProject(input.projectId, charter.projectId, `departmentCharter:${charter.id}`);
  });
  if (input.requirements.sessionId !== input.sessionId) {
    throw new Error('requirements.sessionId 不属于当前 session');
  }
  if (input.solution.requirementsId !== input.requirements.id) {
    throw new Error('solution.requirementsId 与 requirements 不一致');
  }
  if (input.feasibility.requirementsId !== input.requirements.id) {
    throw new Error('feasibility.requirementsId 与 requirements 不一致');
  }
  if (input.feasibility.solutionId !== input.solution.id) {
    throw new Error('feasibility.solutionId 与 solution 不一致');
  }
  const charterIds = new Set<string>();
  input.departmentCharters.forEach((charter) => {
    if (charterIds.has(charter.id)) throw new Error(`department charter id 不能重复：${charter.id}`);
    charterIds.add(charter.id);
  });
  requirePositiveSafeInteger(input.requirements.baselineVersion, 'requirements.baselineVersion');
  requirePositiveSafeInteger(input.milestonePlan.planVersion, 'milestonePlan.planVersion');
  requireNonNegativeSafeInteger(input.feasibility.estimatedCostCents, 'feasibility.estimatedCostCents');
  requireNonNegativeSafeInteger(input.feasibility.estimatedDurationMs, 'feasibility.estimatedDurationMs');
  requirePositiveSafeInteger(input.milestonePlan.milestones.length, 'milestonePlan.milestones');
  input.milestonePlan.milestones.forEach((milestone, index) => {
    requiredText(milestone.id, `milestonePlan.milestones[${index}].id`);
    requiredText(milestone.title, `milestonePlan.milestones[${index}].title`);
    requiredText(milestone.outcome, `milestonePlan.milestones[${index}].outcome`);
  });
  input.departmentCharters.forEach((charter, index) => {
    requiredText(charter.id, `departmentCharters[${index}].id`);
    requiredText(charter.departmentId, `departmentCharters[${index}].departmentId`);
    requiredText(charter.objective, `departmentCharters[${index}].objective`);
  });
}

export function createProjectPlanDraft(input: CreateProjectPlanDraftInput): ProjectPlan {
  validatePlanningSources(input);
  const id = requiredText(input.id, 'project plan id');
  const projectId = requiredText(input.projectId, 'project id');
  const sessionId = requiredText(input.sessionId, 'session id');
  const now = requiredText(input.now, '时间');
  const departmentCharterRefs = input.departmentCharters.map((charter) => ({
    id: charter.id,
    version: charter.version,
  }));

  return {
    version: 1,
    id,
    projectId,
    sessionId,
    planVersion: 1,
    requirementsRef: {
      id: input.requirements.id,
      version: input.requirements.baselineVersion,
    },
    solutionRef: {
      id: input.solution.id,
      version: input.solution.version,
    },
    feasibilityRef: {
      id: input.feasibility.id,
      version: input.feasibility.version,
    },
    milestonePlanRef: {
      id: input.milestonePlan.id,
      version: input.milestonePlan.planVersion,
    },
    departmentCharterRefs,
    feasibilityStatus: input.feasibility.status,
    blockingQuestionCount: input.requirements.unresolvedQuestions.length
      + input.feasibility.blockingRisks.length,
    approval: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

export function approveProjectPlan(
  plan: ProjectPlan,
  approvedBy: string,
  now: string,
): ProjectPlan {
  if (plan.approval !== 'draft') {
    throw new Error(`项目计划当前不能批准：${plan.approval}`);
  }
  if (plan.feasibilityStatus === 'infeasible') {
    throw new Error('项目计划不可行，不能批准');
  }
  if (plan.blockingQuestionCount > 0) {
    throw new Error('项目计划仍有未解决问题或阻塞风险，不能批准');
  }
  return {
    ...plan,
    approval: 'approved',
    approvedBy: requiredText(approvedBy, '批准人'),
    approvedAt: requiredText(now, '批准时间'),
    updatedAt: requiredText(now, '更新时间'),
  };
}

export function createDepartmentWorkPackage(
  input: CreateDepartmentWorkPackageInput,
): DepartmentWorkPackage {
  if (input.plan.approval !== 'approved') {
    throw new Error(`项目计划尚未批准，不能下发部门 Work Package：${input.plan.approval}`);
  }
  const id = requiredText(input.id, 'Work Package id');
  const departmentCharterId = requiredText(input.departmentCharterId, 'department charter id');
  requireReferenceId(departmentCharterId, input.plan.departmentCharterRefs, 'department charter');
  const taskGraphId = requiredText(input.taskGraphId, 'task graph id');
  const milestoneIds = copyTexts(input.milestoneIds, 'milestoneIds');
  const scope = copyTexts(input.scope, 'scope');
  const nonGoals = copyTexts(input.nonGoals, 'nonGoals');
  const dependencies = copyTexts(input.dependencies, 'dependencies');
  const acceptanceCriteria = copyTexts(input.acceptanceCriteria, 'acceptanceCriteria');
  if (milestoneIds.length === 0) throw new Error('Work Package 至少需要一个里程碑');
  if (scope.length === 0) throw new Error('Work Package scope 不能为空');
  if (acceptanceCriteria.length === 0) throw new Error('Work Package acceptanceCriteria 不能为空');
  const now = requiredText(input.now, '时间');

  return {
    version: 1,
    id,
    projectId: input.plan.projectId,
    planId: input.plan.id,
    planVersion: input.plan.planVersion,
    departmentCharterId,
    taskGraphId,
    milestoneIds,
    scope,
    nonGoals,
    dependencies,
    acceptanceCriteria,
    status: 'dispatched',
    createdAt: now,
    updatedAt: now,
    dispatchedAt: now,
  };
}

export interface ReviseProjectPlanInput {
  plan: ProjectPlan;
  id: string;
  now: string;
  blockingQuestionCount?: number;
  feasibilityStatus?: ProjectPlan['feasibilityStatus'];
  requirementsRef?: PlanningReference;
  solutionRef?: PlanningReference;
  feasibilityRef?: PlanningReference;
  milestonePlanRef?: PlanningReference;
  departmentCharterRefs?: readonly PlanningReference[];
}

export function reviseProjectPlan(input: ReviseProjectPlanInput): ProjectPlan {
  if (input.plan.approval === 'superseded') {
    throw new Error('已失效的项目计划不能再次生成 revision');
  }
  const id = requiredText(input.id, '新项目计划 id');
  if (id === input.plan.id) throw new Error('项目计划 revision 必须使用新的 id');
  const now = requiredText(input.now, '时间');
  const blockingQuestionCount = input.blockingQuestionCount ?? input.plan.blockingQuestionCount;
  requireNonNegativeSafeInteger(blockingQuestionCount, 'blockingQuestionCount');

  return {
    ...input.plan,
    id,
    planVersion: input.plan.planVersion + 1,
    requirementsRef: input.requirementsRef ?? { ...input.plan.requirementsRef },
    solutionRef: input.solutionRef ?? { ...input.plan.solutionRef },
    feasibilityRef: input.feasibilityRef ?? { ...input.plan.feasibilityRef },
    milestonePlanRef: input.milestonePlanRef ?? { ...input.plan.milestonePlanRef },
    departmentCharterRefs: input.departmentCharterRefs
      ? input.departmentCharterRefs.map((reference) => ({ ...reference }))
      : input.plan.departmentCharterRefs.map((reference) => ({ ...reference })),
    feasibilityStatus: input.feasibilityStatus ?? input.plan.feasibilityStatus,
    blockingQuestionCount,
    approval: 'draft',
    approvedBy: undefined,
    approvedAt: undefined,
    createdAt: now,
    updatedAt: now,
    revisionOf: input.plan.id,
    supersededBy: undefined,
  };
}

export interface CreateDebateRequestInput {
  id: string;
  projectId: string;
  planId: string;
  question: string;
  evidencePackRefs: readonly PlanningReference[];
  maxRounds: number;
  maxModels: number;
  maxTokens: number;
  maxMoneyCents: number;
  now: string;
}

export interface CreateDebateOpinionInput {
  request: DebateRequest;
  id: string;
  role: string;
  proposal: string;
  assumptions: readonly string[];
  risks: readonly string[];
  evidenceRefs: readonly PlanningReference[];
  confidence: PlanningConfidence;
  now: string;
}

export interface CreateDebateVerdictInput {
  request: DebateRequest;
  id: string;
  opinions: readonly DebateOpinion[];
  recommendation: string;
  minorityOpinions: readonly string[];
  unresolvedQuestions: readonly string[];
  evidenceRefs: readonly PlanningReference[];
  now: string;
}

function copyPlanningReferences(
  references: readonly PlanningReference[],
  field: string,
): PlanningReference[] {
  return references.map((reference, index) => {
    const id = requiredText(reference.id, `${field}[${index}].id`);
    requirePositiveSafeInteger(reference.version, `${field}[${index}].version`);
    return { id, version: reference.version };
  });
}

function assertEvidencePackSubset(
  evidenceRefs: readonly PlanningReference[],
  evidencePackRefs: readonly PlanningReference[],
  field: string,
): void {
  evidenceRefs.forEach((reference, index) => {
    if (!evidencePackRefs.some((candidate) => candidate.id === reference.id && candidate.version === reference.version)) {
      throw new Error(`${field}[${index}] 不在冻结的 EvidencePack 中`);
    }
  });
}

function planningConfidence(value: PlanningConfidence): PlanningConfidence {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new Error(`confidence 不是有效等级：${value}`);
  }
  return value;
}

export function createDebateRequest(input: CreateDebateRequestInput): DebateRequest {
  const evidencePackRefs = copyPlanningReferences(input.evidencePackRefs, 'evidencePackRefs');
  if (evidencePackRefs.length === 0) throw new Error('EvidencePack 不能为空');
  return {
    version: 1,
    id: requiredText(input.id, 'debate id'),
    projectId: requiredText(input.projectId, 'project id'),
    planId: requiredText(input.planId, 'project plan id'),
    question: requiredText(input.question, 'debate question'),
    evidencePackRefs,
    maxRounds: input.maxRounds,
    maxModels: input.maxModels,
    maxTokens: input.maxTokens,
    maxMoneyCents: input.maxMoneyCents,
    createdAt: requiredText(input.now, '时间'),
  };
}

export function createDebateOpinion(input: CreateDebateOpinionInput): DebateOpinion {
  const evidenceRefs = copyPlanningReferences(input.evidenceRefs, 'evidenceRefs');
  assertEvidencePackSubset(evidenceRefs, input.request.evidencePackRefs, 'evidenceRefs');
  return {
    version: 1,
    id: requiredText(input.id, 'opinion id'),
    debateId: input.request.id,
    role: requiredText(input.role, 'opinion role'),
    proposal: requiredText(input.proposal, 'opinion proposal'),
    assumptions: copyTexts(input.assumptions, 'assumptions'),
    risks: copyTexts(input.risks, 'risks'),
    evidenceRefs,
    confidence: planningConfidence(input.confidence),
    createdAt: requiredText(input.now, '时间'),
  };
}

export function createDebateVerdict(input: CreateDebateVerdictInput): DebateVerdict {
  if (input.opinions.length === 0) throw new Error('verdict 至少需要一个 debate opinion');
  const opinionIds = new Set<string>();
  input.opinions.forEach((opinion, index) => {
    if (opinion.debateId !== input.request.id) {
      throw new Error(`opinions[${index}] 不属于当前 debate`);
    }
    if (opinionIds.has(opinion.id)) throw new Error(`opinions 不能重复：${opinion.id}`);
    opinionIds.add(opinion.id);
  });
  const evidenceRefs = copyPlanningReferences(input.evidenceRefs, 'evidenceRefs');
  assertEvidencePackSubset(evidenceRefs, input.request.evidencePackRefs, 'evidenceRefs');
  return {
    version: 1,
    id: requiredText(input.id, 'verdict id'),
    debateId: input.request.id,
    recommendation: requiredText(input.recommendation, 'verdict recommendation'),
    opinionRefs: input.opinions.map((opinion) => ({ id: opinion.id, version: opinion.version })),
    minorityOpinions: copyTexts(input.minorityOpinions, 'minorityOpinions'),
    unresolvedQuestions: copyTexts(input.unresolvedQuestions, 'unresolvedQuestions'),
    evidenceRefs,
    status: 'draft',
    createdAt: requiredText(input.now, '时间'),
  };
}
