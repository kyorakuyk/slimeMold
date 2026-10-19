import { describe, expect, it } from 'vitest';
import { createIssueCommand, transitionIssueCommand } from './issues';
import { createIssue } from '../issue';
import { architectureSnapshot } from '../commands.testFixtures';

describe('Issue command owner', () => {
  it('creates an Issue projection and an IssueCreated fact', () => {
    const issue = createIssue({
      id: 'issue-2',
      projectId: null,
      type: 'bug',
      title: '发现问题',
      description: '需要修复',
      createdAt: '2026-09-01T00:01:00.000Z',
    });
    const result = createIssueCommand({
      snapshot: architectureSnapshot(),
      projectId: 'project-1',
      issue,
      now: '2026-09-01T00:01:00.000Z',
    });

    expect(result.snapshot.issues).toEqual([issue]);
    expect(result.events).toEqual([expect.objectContaining({
      streamId: 'project-1',
      aggregateType: 'Issue',
      aggregateId: 'issue-2',
      eventType: 'IssueCreated',
      payload: expect.objectContaining({ issueId: 'issue-2', projectId: null, issueType: 'bug' }),
    })]);
  });

  it('transitions an Issue and rejects a command scoped to another project', () => {
    const issue = createIssue({
      id: 'issue-1',
      projectId: 'project-1',
      type: 'feature',
      title: '功能',
      description: '实现功能',
      sourceSessionId: 'session-1',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const created = createIssueCommand({
      snapshot: architectureSnapshot(),
      issue,
      now: '2026-09-01T00:00:00.000Z',
    });
    const transitioned = transitionIssueCommand({
      snapshot: created.snapshot,
      projectId: 'project-1',
      issueId: 'issue-1',
      status: 'triaging',
      now: '2026-09-01T00:01:00.000Z',
    });

    expect(transitioned.snapshot.issues[0].status).toBe('triaging');
    expect(transitioned.events).toEqual([expect.objectContaining({
      eventType: 'IssueStatusChanged',
      aggregateId: 'issue-1',
      payload: expect.objectContaining({ from: 'inbox', to: 'triaging', issueId: 'issue-1' }),
    })]);
    expect(() => transitionIssueCommand({
      snapshot: created.snapshot,
      projectId: 'project-2',
      issueId: 'issue-1',
      status: 'triaging',
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/不属于当前项目/);
  });
});
