import type { ProjectIssue, ProjectIssuePriority, ProjectIssueStatus, ProjectIssueType } from './types';

export const ISSUE_TRANSITIONS: Record<ProjectIssueStatus, ReadonlySet<ProjectIssueStatus>> = {
  inbox: new Set(['triaging', 'proposed', 'cancelled']),
  triaging: new Set(['inbox', 'proposed', 'cancelled']),
  proposed: new Set(['inbox', 'approved', 'cancelled']),
  approved: new Set(['queued', 'cancelled']),
  queued: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['review', 'blocked', 'cancelled']),
  review: new Set(['in_progress', 'done', 'blocked', 'cancelled']),
  blocked: new Set(['triaging', 'in_progress', 'cancelled']),
  done: new Set(['operating']),
  operating: new Set(['paused']),
  paused: new Set(['operating', 'in_progress', 'cancelled']),
  cancelled: new Set(),
};

export interface CreateIssueInput {
  id: string;
  projectId: string | null;
  type: ProjectIssueType;
  title: string;
  description: string;
  tags?: string[];
  priority?: ProjectIssuePriority;
  sourceSessionId?: string;
  relatedArtifactIds?: string[];
  relatedTaskIds?: string[];
  relatedRunId?: string | number;
  createdAt: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

export function createIssue(input: CreateIssueInput): ProjectIssue {
  return {
    version: 1,
    id: requiredText(input.id, 'Issue id'),
    projectId: input.projectId,
    type: input.type,
    status: 'inbox',
    priority: input.priority ?? 'normal',
    title: requiredText(input.title, 'Issue 标题'),
    description: requiredText(input.description, 'Issue 描述'),
    tags: [...(input.tags ?? [])].map((tag) => tag.trim()).filter(Boolean),
    sourceSessionId: input.sourceSessionId,
    relatedArtifactIds: [...(input.relatedArtifactIds ?? [])],
    relatedTaskIds: [...(input.relatedTaskIds ?? [])],
    relatedRunId: input.relatedRunId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function transitionIssue(
  issue: ProjectIssue,
  status: ProjectIssueStatus,
  now: string,
): ProjectIssue {
  if (issue.status === status) return { ...issue, updatedAt: now };
  const directProjectApproval =
    status === 'approved' &&
    issue.projectId !== null &&
    (issue.status === 'inbox' || issue.status === 'triaging');
  if (!ISSUE_TRANSITIONS[issue.status].has(status) && !directProjectApproval) {
    throw new Error(`Issue 状态不允许迁移：${issue.status} → ${status}`);
  }
  return { ...issue, status, updatedAt: now };
}

/** 提出项目归类建议；建议本身不改变 projectId，也不进入执行队列。 */
export function proposeIssueProject(
  issue: ProjectIssue,
  projectId: string,
  now: string,
): ProjectIssue {
  const proposed = requiredText(projectId, '建议项目 id');
  if (issue.status !== 'inbox' && issue.status !== 'triaging') {
    throw new Error(`当前 Issue 状态不能提出项目归类建议：${issue.status}`);
  }
  return {
    ...issue,
    status: 'proposed',
    proposedProjectId: proposed,
    updatedAt: now,
  };
}

/** 用户批准项目归类后才真正写入 projectId，并进入 approved 队列。 */
export function approveIssueProject(issue: ProjectIssue, now: string): ProjectIssue {
  if (issue.status !== 'proposed' || !issue.proposedProjectId) {
    throw new Error('Issue 没有等待批准的项目归类建议');
  }
  return {
    ...issue,
    projectId: issue.proposedProjectId,
    proposedProjectId: undefined,
    status: 'approved',
    updatedAt: now,
  };
}
