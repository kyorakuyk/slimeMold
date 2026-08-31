import type {
  Decision,
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectIssue,
  ProjectSession,
  ProjectTaskGraph,
} from './types';

const CURRENT_VERSION = 1 as const;

export function createEmptyProjectControlSnapshot(): ProjectControlSnapshot {
  return {
    version: CURRENT_VERSION,
    activeSessionId: null,
    sessions: [],
    decisions: [],
    briefs: [],
    architectures: [],
    issues: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectSession(value: unknown): value is ProjectSession {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.messages) &&
    Array.isArray(value.openQuestions) &&
    Array.isArray(value.decisionIds) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isDecision(value: unknown): value is Decision {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.key === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isProjectBrief(value: unknown): value is ProjectBrief {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.briefVersion === 'number' &&
    typeof value.goal === 'string' &&
    Array.isArray(value.users) &&
    Array.isArray(value.scope) &&
    Array.isArray(value.nonGoals) &&
    Array.isArray(value.constraints) &&
    Array.isArray(value.acceptanceCriteria) &&
    Array.isArray(value.assumptions) &&
    typeof value.approval === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isProjectArchitecture(value: unknown): value is ProjectArchitecture {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.briefId === 'string' &&
    typeof value.architectureVersion === 'number' &&
    typeof value.overview === 'string' &&
    Array.isArray(value.modules) &&
    Array.isArray(value.interfaces) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.risks) &&
    typeof value.approval === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isProjectIssue(value: unknown): value is ProjectIssue {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    (value.projectId === null || typeof value.projectId === 'string') &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.status === 'string' &&
    typeof value.priority === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.tags) &&
    Array.isArray(value.relatedArtifactIds) &&
    Array.isArray(value.relatedTaskIds) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isProjectTaskGraph(value: unknown): value is ProjectTaskGraph {
  if (!isRecord(value)) return false;
  return (
    value.version === CURRENT_VERSION &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.architectureId === 'string' &&
    typeof value.graphVersion === 'number' &&
    Array.isArray(value.tasks) &&
    typeof value.approval === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 将项目控制面保存为 JSON。调用方负责把结果写到项目目录；本函数不产生 I/O。
 */
export function serializeProjectControlSnapshot(snapshot: ProjectControlSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * 恢复项目控制面。
 *
 * 该入口故意不抛出解析/结构错误：控制面损坏不应阻塞旧项目的工作流和产物打开。
 * 无效的单条记录会被丢弃；若顶层结构不完整，则整体降级为空快照。
 */
export function parseProjectControlSnapshot(input: unknown): ProjectControlSnapshot {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return createEmptyProjectControlSnapshot();
    }
  }
  if (!isRecord(value) || value.version !== CURRENT_VERSION) {
    return createEmptyProjectControlSnapshot();
  }
  if (!Array.isArray(value.sessions) || !Array.isArray(value.decisions) || !Array.isArray(value.briefs)) {
    return createEmptyProjectControlSnapshot();
  }

  const sessions = value.sessions.filter(isProjectSession).map(clone);
  const decisions = value.decisions.filter(isDecision).map(clone);
  const briefs = value.briefs.filter(isProjectBrief).map(clone);
  const architectures = Array.isArray(value.architectures)
    ? value.architectures.filter(isProjectArchitecture).map(clone)
    : [];
  const issues = Array.isArray(value.issues)
    ? value.issues.filter(isProjectIssue).map(clone)
    : [];
  const taskGraphs = Array.isArray(value.taskGraphs)
    ? value.taskGraphs.filter(isProjectTaskGraph).map(clone)
    : undefined;
  const activeSessionId =
    typeof value.activeSessionId === 'string' && sessions.some((session) => session.id === value.activeSessionId)
      ? value.activeSessionId
      : null;

  const snapshot: ProjectControlSnapshot = {
    version: CURRENT_VERSION,
    activeSessionId,
    sessions,
    decisions,
    briefs,
    architectures,
    issues,
  };
  if (taskGraphs) snapshot.taskGraphs = taskGraphs;
  return snapshot;
}
