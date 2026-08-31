import type {
  ArchitectureInterface,
  ArchitectureModule,
  ArchitectureTask,
  Decision,
  OpenQuestion,
  ProjectArchitecture,
  ProjectBrief,
  ProjectSession,
  SessionMessage,
  ProjectSessionStatus,
} from './types';

/**
 * ProjectSession 的状态迁移表。
 *
 * 这里用有限状态机约束主控会话的生命周期：UI 或模型不能直接把会话
 * 从澄清阶段跳到交付阶段，必须经过可解释的计划和确认步骤。
 */
export const SESSION_TRANSITIONS: Record<
  ProjectSessionStatus,
  ReadonlySet<ProjectSessionStatus>
> = {
  intake: new Set(['clarifying', 'cancelled']),
  clarifying: new Set(['brief-review', 'paused', 'cancelled']),
  'brief-review': new Set(['clarifying', 'architecture-review', 'ready', 'cancelled']),
  'architecture-review': new Set(['brief-review', 'plan-review', 'awaiting-user', 'cancelled']),
  'plan-review': new Set(['architecture-review', 'ready', 'awaiting-user', 'cancelled']),
  ready: new Set(['executing', 'paused', 'cancelled']),
  executing: new Set(['blocked', 'awaiting-user', 'paused', 'delivered', 'cancelled']),
  blocked: new Set(['clarifying', 'plan-review', 'ready', 'paused', 'cancelled']),
  'awaiting-user': new Set(['clarifying', 'brief-review', 'architecture-review', 'plan-review', 'ready', 'paused', 'cancelled']),
  paused: new Set(['clarifying', 'ready', 'executing', 'cancelled']),
  delivered: new Set(['operating']),
  operating: new Set(['paused', 'awaiting-user']),
  cancelled: new Set(),
};

export interface CreateProjectSessionInput {
  id: string;
  projectId: string;
  goal: string;
  now: string;
}

export interface CreateOpenQuestionInput {
  id: string;
  prompt: string;
  createdAt: string;
}

export interface CreateDecisionInput {
  id: string;
  sessionId: string;
  key: string;
  value: unknown;
  version: number;
  now: string;
  rationale?: string;
  supersedesId?: string;
}

export interface CreateProjectBriefInput {
  id: string;
  sessionId: string;
  version: number;
  goal: string;
  users: string[];
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  now: string;
}

export interface CreateProjectArchitectureInput {
  id: string;
  sessionId: string;
  briefId: string;
  version: number;
  overview: string;
  modules: ArchitectureModule[];
  interfaces: ArchitectureInterface[];
  tasks: ArchitectureTask[];
  risks: string[];
  now: string;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function replaceQuestion(
  session: ProjectSession,
  questionId: string,
  updater: (question: OpenQuestion) => OpenQuestion,
): ProjectSession {
  const index = session.openQuestions.findIndex((question) => question.id === questionId);
  if (index < 0) throw new Error(`问题不存在：${questionId}`);
  const openQuestions = [...session.openQuestions];
  openQuestions[index] = updater(openQuestions[index]);
  return { ...session, openQuestions };
}

export function createProjectSession(input: CreateProjectSessionInput): ProjectSession {
  const goal = requireText(input.goal, '项目目标');
  const message: SessionMessage = {
    id: `${input.id}:message:1`,
    role: 'user',
    content: goal,
    createdAt: input.now,
  };
  return {
    version: 1,
    id: requireText(input.id, '会话 id'),
    projectId: requireText(input.projectId, '项目 id'),
    status: 'clarifying',
    messages: [message],
    openQuestions: [],
    decisionIds: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function transitionSession(
  session: ProjectSession,
  status: ProjectSessionStatus,
  now: string,
): ProjectSession {
  if (session.status === status) return { ...session, updatedAt: now };
  if (!SESSION_TRANSITIONS[session.status].has(status)) {
    throw new Error(`会话状态不允许迁移：${session.status} → ${status}`);
  }
  return { ...session, status, updatedAt: now };
}

export function appendSessionMessage(
  session: ProjectSession,
  message: SessionMessage,
): ProjectSession {
  if (!message.id.trim()) throw new Error('消息 id 不能为空');
  if (!message.content.trim()) throw new Error('消息内容不能为空');
  if (session.messages.some((item) => item.id === message.id)) {
    throw new Error(`消息已存在：${message.id}`);
  }
  return {
    ...session,
    messages: [...session.messages, { ...message, content: message.content.trim() }],
    updatedAt: message.createdAt,
  };
}

export function addOpenQuestion(
  session: ProjectSession,
  input: CreateOpenQuestionInput,
): ProjectSession {
  const prompt = requireText(input.prompt, '问题');
  if (session.openQuestions.some((question) => question.id === input.id)) {
    throw new Error(`问题已存在：${input.id}`);
  }
  return {
    ...session,
    openQuestions: [
      ...session.openQuestions,
      { id: requireText(input.id, '问题 id'), prompt, status: 'open', createdAt: input.createdAt },
    ],
    updatedAt: input.createdAt,
  };
}

export function answerOpenQuestion(
  session: ProjectSession,
  questionId: string,
  answer: string,
  now: string,
): ProjectSession {
  const normalized = requireText(answer, '问题回答');
  return replaceQuestion(session, questionId, (question) => {
    if (question.status === 'answered') throw new Error(`问题已经回答：${questionId}`);
    if (question.status === 'deferred') throw new Error(`问题已暂缓：${questionId}`);
    return { ...question, status: 'answered', answer: normalized, answeredAt: now };
  });
}

export function createDecision(input: CreateDecisionInput): Decision {
  return {
    version: 1,
    id: requireText(input.id, 'Decision id'),
    sessionId: requireText(input.sessionId, '会话 id'),
    key: requireText(input.key, 'Decision key'),
    value: input.value,
    status: 'proposed',
    createdAt: input.now,
    updatedAt: input.now,
    rationale: input.rationale?.trim() || undefined,
    supersedesId: input.supersedesId,
  };
}

export function approveDecision(
  decision: Decision,
  approvedBy: string,
  now: string,
): Decision {
  if (decision.status !== 'proposed') {
    throw new Error(`Decision 当前状态不能批准：${decision.status}`);
  }
  return {
    ...decision,
    status: 'approved',
    approvedBy: requireText(approvedBy, '批准人'),
    approvedAt: now,
    updatedAt: now,
  };
}

export function createProjectBrief(input: CreateProjectBriefInput): ProjectBrief {
  return {
    version: 1,
    id: requireText(input.id, 'Brief id'),
    sessionId: requireText(input.sessionId, '会话 id'),
    briefVersion: input.version,
    goal: requireText(input.goal, 'Brief 目标'),
    users: [...input.users],
    scope: [...input.scope],
    nonGoals: [...input.nonGoals],
    constraints: [...input.constraints],
    acceptanceCriteria: [...input.acceptanceCriteria],
    assumptions: [...input.assumptions],
    approval: 'draft',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function approveBrief(
  brief: ProjectBrief,
  approvedBy: string,
  now: string,
): ProjectBrief {
  if (brief.approval !== 'draft') {
    throw new Error(`Brief 已经批准或已失效：${brief.approval}`);
  }
  return {
    ...brief,
    approval: 'approved',
    approvedBy: requireText(approvedBy, '批准人'),
    approvedAt: now,
    updatedAt: now,
  };
}

export function createProjectArchitecture(input: CreateProjectArchitectureInput): ProjectArchitecture {
  return {
    version: 1,
    id: requireText(input.id, '架构 id'),
    sessionId: requireText(input.sessionId, '会话 id'),
    briefId: requireText(input.briefId, 'Brief id'),
    architectureVersion: input.version,
    overview: requireText(input.overview, '架构概览'),
    modules: input.modules.map((module) => ({
      ...module,
      id: requireText(module.id, '模块 id'),
      name: requireText(module.name, '模块名称'),
      responsibility: requireText(module.responsibility, '模块职责'),
      category: requireText(module.category, '模块 category'),
      scope: [...module.scope],
      dependsOn: [...module.dependsOn],
    })),
    interfaces: input.interfaces.map((item) => ({ ...item })),
    tasks: input.tasks.map((task) => ({
      ...task,
      scope: [...task.scope],
      dependsOn: [...task.dependsOn],
      acceptanceCriteria: [...task.acceptanceCriteria],
    })),
    risks: [...input.risks],
    approval: 'draft',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function approveArchitecture(
  architecture: ProjectArchitecture,
  approvedBy: string,
  now: string,
): ProjectArchitecture {
  if (architecture.approval !== 'draft') {
    throw new Error(`架构已批准或已失效：${architecture.approval}`);
  }
  return {
    ...architecture,
    approval: 'approved',
    approvedBy: requireText(approvedBy, '批准人'),
    approvedAt: now,
    updatedAt: now,
  };
}
