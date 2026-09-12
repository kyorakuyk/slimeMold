export type ProjectControlVersion = 1;

export type ProjectSessionStatus =
  | 'intake'
  | 'clarifying'
  | 'brief-review'
  | 'architecture-review'
  | 'plan-review'
  | 'ready'
  | 'executing'
  | 'blocked'
  | 'awaiting-user'
  | 'paused'
  | 'delivered'
  | 'operating'
  | 'cancelled';

export type SessionMessageRole = 'user' | 'assistant' | 'system';

export interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: string;
}

export type OpenQuestionStatus = 'open' | 'answered' | 'deferred';

export interface OpenQuestion {
  id: string;
  prompt: string;
  status: OpenQuestionStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

export type DecisionStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';

export interface Decision {
  version: ProjectControlVersion;
  id: string;
  sessionId: string;
  key: string;
  value: unknown;
  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rationale?: string;
  supersedesId?: string;
}

export type BriefApproval = 'draft' | 'approved' | 'superseded';

export interface ProjectBrief {
  version: ProjectControlVersion;
  id: string;
  sessionId: string;
  briefVersion: number;
  goal: string;
  users: string[];
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  approval: BriefApproval;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ProjectSession {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  status: ProjectSessionStatus;
  messages: SessionMessage[];
  openQuestions: OpenQuestion[];
  decisionIds: string[];
  briefId?: string;
  architectureId?: string;
  taskGraphId?: string;
  orchestrationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureModule {
  id: string;
  name: string;
  responsibility: string;
  category: string;
  scope: string[];
  dependsOn: string[];
}

export interface ArchitectureInterface {
  id: string;
  name: string;
  description: string;
}

export interface ArchitectureTask {
  id: string;
  title: string;
  description: string;
  moduleId: string;
  scope: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  category: string;
}

export type ArchitectureApproval = 'draft' | 'approved' | 'superseded';

export interface ProjectArchitecture {
  version: ProjectControlVersion;
  id: string;
  sessionId: string;
  briefId: string;
  architectureVersion: number;
  overview: string;
  modules: ArchitectureModule[];
  interfaces: ArchitectureInterface[];
  tasks: ArchitectureTask[];
  risks: string[];
  approval: ArchitectureApproval;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export type ProjectIssueType = 'idea' | 'feature' | 'bug' | 'risk' | 'question';

export type ProjectIssueStatus =
  | 'inbox'
  | 'triaging'
  | 'proposed'
  | 'approved'
  | 'queued'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'operating'
  | 'paused'
  | 'cancelled';

export type ProjectIssuePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ProjectIssue {
  version: ProjectControlVersion;
  id: string;
  projectId: string | null;
  proposedProjectId?: string;
  type: ProjectIssueType;
  status: ProjectIssueStatus;
  priority: ProjectIssuePriority;
  title: string;
  description: string;
  tags: string[];
  sourceSessionId?: string;
  relatedArtifactIds: string[];
  relatedTaskIds: string[];
  relatedRunId?: string | number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectTaskStatus = 'proposed' | 'approved' | 'queued' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

export interface ProjectTask {
  version: ProjectControlVersion;
  id: string;
  architectureId: string;
  issueId?: string;
  title: string;
  description: string;
  moduleId: string;
  scope: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  category: string;
  status: ProjectTaskStatus;
  workflowId?: string;
  stageId?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskGraphApproval = 'draft' | 'approved' | 'superseded';

export interface ProjectTaskGraphRevisionChange {
  taskId: string;
  title?: string;
  description?: string;
  dependsOn?: string[];
}

export interface ProjectTaskGraph {
  version: ProjectControlVersion;
  id: string;
  sessionId: string;
  architectureId: string;
  graphVersion: number;
  tasks: ProjectTask[];
  approval: TaskGraphApproval;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  revisionOf?: string;
  supersededBy?: string;
}

export interface ProjectControlSnapshot {
  version: ProjectControlVersion;
  activeSessionId: string | null;
  masterAgentId?: string | null;
  sessions: ProjectSession[];
  decisions: Decision[];
  briefs: ProjectBrief[];
  architectures: ProjectArchitecture[];
  issues: ProjectIssue[];
  taskGraphs?: ProjectTaskGraph[];
}

export type ProjectPlanApproval = 'draft' | 'approved' | 'superseded';
export type FeasibilityStatus = 'feasible' | 'conditional' | 'infeasible';
export type PlanningConfidence = 'low' | 'medium' | 'high';

export interface PlanningReference {
  id: string;
  version: number;
}

export interface RequirementsBaseline {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  sessionId: string;
  baselineVersion: number;
  goal: string;
  scope: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  createdAt: string;
}

export interface CrossDepartmentContract {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  producerDepartmentId: string;
  consumerDepartmentId: string;
  name: string;
  inputs: string[];
  outputs: string[];
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface SolutionOutline {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  requirementsId: string;
  overview: string;
  moduleIds: string[];
  crossDepartmentContractIds: string[];
  createdAt: string;
}

export interface FeasibilityAssessment {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  requirementsId: string;
  solutionId: string;
  status: FeasibilityStatus;
  blockingRisks: string[];
  dependencies: string[];
  requiredCapabilities: string[];
  estimatedCostCents: number;
  estimatedDurationMs: number;
  confidence: PlanningConfidence;
  createdAt: string;
}

export interface Milestone {
  id: string;
  title: string;
  outcome: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
}

export interface MilestonePlan {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  planVersion: number;
  milestones: Milestone[];
  createdAt: string;
}

export interface DepartmentCharter {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  departmentId: string;
  name: string;
  objective: string;
  scope: string[];
  nonGoals: string[];
  milestoneIds: string[];
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface ProjectPlan {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  sessionId: string;
  planVersion: number;
  requirementsRef: PlanningReference;
  solutionRef: PlanningReference;
  feasibilityRef: PlanningReference;
  milestonePlanRef: PlanningReference;
  departmentCharterRefs: PlanningReference[];
  feasibilityStatus: FeasibilityStatus;
  blockingQuestionCount: number;
  approval: ProjectPlanApproval;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  revisionOf?: string;
  supersededBy?: string;
}

export type DepartmentWorkPackageStatus = 'proposed' | 'dispatched' | 'superseded';

export interface DepartmentWorkPackage {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  planId: string;
  planVersion: number;
  departmentCharterId: string;
  taskGraphId: string;
  milestoneIds: string[];
  scope: string[];
  nonGoals: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  status: DepartmentWorkPackageStatus;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
}

export interface ArchitectureDecision {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  planId: string;
  question: string;
  options: string[];
  recommendation?: string;
  evidenceRefs: PlanningReference[];
  status: ProjectPlanApproval;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface DebateRequest {
  version: ProjectControlVersion;
  id: string;
  projectId: string;
  planId: string;
  question: string;
  evidencePackRefs: PlanningReference[];
  maxRounds: number;
  maxModels: number;
  maxTokens: number;
  maxMoneyCents: number;
  createdAt: string;
}

export interface DebateOpinion {
  version: ProjectControlVersion;
  id: string;
  debateId: string;
  role: string;
  proposal: string;
  assumptions: string[];
  risks: string[];
  evidenceRefs: PlanningReference[];
  confidence: PlanningConfidence;
  createdAt: string;
}

export interface DebateVerdict {
  version: ProjectControlVersion;
  id: string;
  debateId: string;
  recommendation: string;
  opinionRefs: PlanningReference[];
  minorityOpinions: string[];
  unresolvedQuestions: string[];
  evidenceRefs: PlanningReference[];
  status: ProjectPlanApproval;
  createdAt: string;
}
