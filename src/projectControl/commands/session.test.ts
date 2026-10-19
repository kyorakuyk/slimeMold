import { describe, expect, it } from 'vitest';
import { startProjectSessionCommand } from './session';

describe('session command owner', () => {
  it('creates the initial session projection and ordered project facts', () => {
    const result = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '个人记账应用',
      goal: '做一个个人记账应用，先支持本地版本',
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.snapshot.sessions[0]).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      status: 'clarifying',
    });
    expect(result.events.map((event) => event.eventType)).toEqual([
      'ProjectCreated',
      'SessionStarted',
      'IssueCreated',
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
