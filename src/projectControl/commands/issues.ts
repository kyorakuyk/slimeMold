import type { DomainEvent } from '../../domain/contracts';
import type { ProjectControlSnapshot, ProjectIssue, ProjectIssueStatus } from '../types';
import { transitionIssue } from '../issue';
import { appendFact, requiredText, type ProjectControlCommandResult } from './shared';

export interface CreateIssueCommandInput {
  snapshot: ProjectControlSnapshot;
  issue: ProjectIssue;
  /** 当前项目的 event stream；允许 issue.projectId 为 null 表示未分配。 */
  projectId?: string;
  now: string;
  actor?: DomainEvent['actor'];
}

export function createIssueCommand(input: CreateIssueCommandInput): ProjectControlCommandResult {
  const issueId = requiredText(input.issue.id, 'Issue id');
  const now = requiredText(input.now, '时间');
  if (input.snapshot.issues.some((item) => item.id === issueId)) {
    throw new Error(`Issue 已存在：${issueId}`);
  }
  if (input.projectId && input.issue.projectId && input.projectId !== input.issue.projectId) {
    throw new Error(`Issue 不属于当前项目：${issueId}`);
  }
  const issue = {
    ...input.issue,
    relatedTaskIds: [...input.issue.relatedTaskIds],
  };
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: [issue, ...input.snapshot.issues],
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${issueId}:created`,
    streamId: input.projectId ?? issue.projectId ?? `issue:${issueId}`,
    aggregateType: 'Issue',
    aggregateId: issueId,
    eventType: 'IssueCreated',
    schemaVersion: 1,
    payload: {
      issueId,
      projectId: issue.projectId,
      title: issue.title,
      description: issue.description,
      sourceSessionId: issue.sourceSessionId,
      issueType: issue.type,
      status: issue.status,
      relatedTaskIds: [...issue.relatedTaskIds],
    },
    actor: input.actor ?? 'user',
    occurredAt: now,
    correlationId: issue.sourceSessionId ?? issueId,
    source: { objectId: issueId, objectVersion: issue.version },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}

export interface TransitionIssueCommandInput {
  snapshot: ProjectControlSnapshot;
  projectId?: string;
  issueId: string;
  status: ProjectIssueStatus;
  now: string;
  actor?: DomainEvent['actor'];
}

export function transitionIssueCommand(
  input: TransitionIssueCommandInput,
): ProjectControlCommandResult {
  const issue = input.snapshot.issues.find((item) => item.id === input.issueId);
  if (!issue) throw new Error(`Issue 不存在：${input.issueId}`);
  if (input.projectId && issue.projectId && issue.projectId !== input.projectId) {
    throw new Error(`Issue 不属于当前项目：${input.issueId}`);
  }
  const nextIssue = transitionIssue(issue, input.status, input.now);
  const snapshot: ProjectControlSnapshot = {
    ...input.snapshot,
    issues: input.snapshot.issues.map((item) => (item.id === issue.id ? nextIssue : item)),
  };
  const events: DomainEvent[] = [];
  appendFact(events, {
    eventId: `${issue.id}:status:${input.now}:${nextIssue.status}`,
    streamId: input.projectId ?? issue.projectId ?? `issue:${issue.id}`,
    aggregateType: 'Issue',
    aggregateId: issue.id,
    eventType: 'IssueStatusChanged',
    schemaVersion: 1,
    payload: {
      issueId: issue.id,
      projectId: issue.projectId,
      from: issue.status,
      to: nextIssue.status,
      relatedTaskIds: [...issue.relatedTaskIds],
    },
    actor: input.actor ?? 'user',
    occurredAt: input.now,
    correlationId: issue.sourceSessionId ?? issue.id,
    source: { objectId: issue.id, objectVersion: nextIssue.version },
    sensitivity: 'normal',
  });
  return { snapshot, events };
}
