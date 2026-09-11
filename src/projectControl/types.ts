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
