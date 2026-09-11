import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from './types';
import { enqueueWorkerRunCommand } from './workerRun';

const task: ProjectTask = {
  version: 1,
  id: 'task-1',
  architectureId: 'architecture-1',
  title: '实现任务',
  description: '完成实现',
  moduleId: 'module-1',
  scope: ['src'],
  dependsOn: [],
  acceptanceCriteria: ['测试通过'],
  category: 'implementation',
  status: 'approved',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const taskGraph: ProjectTaskGraph = {
  version: 1,
  id: 'task-graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 2,
  tasks: [task],
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('enqueueWorkerRunCommand', () => {
  it('creates a queued worker registry entry linked to the orchestration', () => {
    const result = enqueueWorkerRunCommand({
      projectId: 'project-1',
      orchestrationId: 'orchestration-1',
      runId: 'run-1',
      taskGraph,
      now: '2026-09-01T00:01:00.000Z',
    });

    expect(result.state).toMatchObject({
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orchestration-1',
      taskGraphId: 'task-graph-1',
      status: 'queued',
    });
    expect(result.state.tasks['task-1'].status).toBe('queued');
    expect(result.events.map((event) => event.eventType)).toEqual(['RunCreated', 'TaskQueued']);
  });

  it('is idempotent for the same run identity and rejects a conflicting retry', () => {
    const first = enqueueWorkerRunCommand({
      projectId: 'project-1',
      orchestrationId: 'orchestration-1',
      runId: 'run-1',
      taskGraph,
      now: '2026-09-01T00:01:00.000Z',
    });
    const retry = enqueueWorkerRunCommand({
      projectId: 'project-1',
      orchestrationId: 'orchestration-1',
      runId: 'run-1',
      taskGraph,
      existingRuns: [first.state],
      now: '2026-09-01T00:02:00.000Z',
    });

    expect(retry.state).toEqual(first.state);
    expect(retry.events).toEqual([]);
    expect(() => enqueueWorkerRunCommand({
      projectId: 'project-1',
      orchestrationId: 'orchestration-2',
      runId: 'run-1',
      taskGraph,
      existingRuns: [first.state],
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/Run 已存在/);
  });
});
