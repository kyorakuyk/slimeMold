import { describe, expect, it } from 'vitest';
import { createIssue, proposeIssueProject, transitionIssue, approveIssueProject } from './issue';

const baseInput = {
  id: 'issue-1',
  projectId: null,
  type: 'idea' as const,
  title: '支持云同步',
  description: '未来希望在多台设备之间同步数据',
  tags: ['sync'],
  createdAt: '2026-08-31T04:00:00.000Z',
};

describe('ProjectIssue state machine', () => {
  it('creates an unassigned issue in the inbox', () => {
    const issue = createIssue(baseInput);

    expect(issue).toMatchObject({
      id: 'issue-1',
      projectId: null,
      type: 'idea',
      status: 'inbox',
      title: '支持云同步',
      tags: ['sync'],
    });
    expect(issue.relatedTaskIds).toEqual([]);
  });

  it('requires a proposal before an issue can enter the approved queue', () => {
    const issue = createIssue(baseInput);
    expect(() => transitionIssue(issue, 'queued', '2026-08-31T04:01:00.000Z')).toThrow(/不允许/);

    const proposed = proposeIssueProject(issue, 'project-2', '2026-08-31T04:01:00.000Z');
    expect(proposed).toMatchObject({ status: 'proposed', projectId: null, proposedProjectId: 'project-2' });

    const approved = approveIssueProject(proposed, '2026-08-31T04:02:00.000Z');
    expect(approved).toMatchObject({ status: 'approved', projectId: 'project-2' });
    expect(issue.status).toBe('inbox');
  });

  it('allows only forward lifecycle transitions and preserves blocked/review states', () => {
    const issue = createIssue({ ...baseInput, projectId: 'project-1' });
    const approved = transitionIssue(issue, 'approved', '2026-08-31T04:01:00.000Z');
    const queued = transitionIssue(approved, 'queued', '2026-08-31T04:02:00.000Z');
    const active = transitionIssue(queued, 'in_progress', '2026-08-31T04:03:00.000Z');
    const review = transitionIssue(active, 'review', '2026-08-31T04:04:00.000Z');
    const blocked = transitionIssue(review, 'blocked', '2026-08-31T04:05:00.000Z');
    const resumed = transitionIssue(blocked, 'in_progress', '2026-08-31T04:06:00.000Z');

    expect(resumed.status).toBe('in_progress');
    expect(resumed.updatedAt).toBe('2026-08-31T04:06:00.000Z');
    expect(() => transitionIssue(issue, 'done', '2026-08-31T04:07:00.000Z')).toThrow(/不允许/);
  });

  it('does not allow a completed project issue to jump back to approved', () => {
    const issue = createIssue({ ...baseInput, projectId: 'project-1' });
    const approved = transitionIssue(issue, 'approved', '2026-08-31T04:01:00.000Z');
    const queued = transitionIssue(approved, 'queued', '2026-08-31T04:02:00.000Z');
    const active = transitionIssue(queued, 'in_progress', '2026-08-31T04:03:00.000Z');
    const review = transitionIssue(active, 'review', '2026-08-31T04:04:00.000Z');
    const done = transitionIssue(review, 'done', '2026-08-31T04:05:00.000Z');

    expect(() => transitionIssue(done, 'approved', '2026-08-31T04:06:00.000Z')).toThrow(/不允许/);
  });
});
