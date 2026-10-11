import { describe, expect, it } from 'vitest';
import { generateTaskGraphCommand } from './taskGraph';
import { architectureSnapshot } from '../commands.testFixtures';
import { taskIssueId } from '../taskGraphProjection';

describe('task graph command owner', () => {
  it('creates the graph projection and its ordered proposal facts', () => {
    const result = generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.snapshot.taskGraphs?.[0]).toMatchObject({
      id: 'task-graph-1',
      approval: 'draft',
      tasks: [expect.objectContaining({ id: 'task-1', status: 'proposed' })],
    });
    expect(result.snapshot.sessions[0].taskGraphId).toBe('task-graph-1');
    expect(result.snapshot.issues).toEqual([
      expect.objectContaining({
        id: taskIssueId('task-graph-1', 'task-1'),
        projectId: 'project-1',
        status: 'proposed',
        relatedTaskIds: ['task-1'],
      }),
    ]);
    expect(result.events.map((event) => event.eventType)).toEqual([
      'TaskGraphProposed',
      'SessionTaskGraphLinked',
      'IssueCreated',
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('rejects a task graph request for a missing session', () => {
    expect(() => generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'missing-session',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    })).toThrow('项目会话不存在：missing-session');
  });
});
