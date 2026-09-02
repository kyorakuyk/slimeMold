import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from './types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { installWorkerRunRuntime, rehydrateWorkerRunRegistry, runActiveWorkerRun } from './workerRunRuntime';

function graph(version = 2): ProjectTaskGraph {
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
  return {
    version: 1,
    id: 'task-graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: version,
    tasks: [task],
    approval: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function run(overrides: Partial<WorkerRunQueueState> = {}): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orchestration-1',
    taskGraphId: 'task-graph-1',
    taskGraphVersion: 2,
    status: 'queued',
    createdAt: '2026-09-01T00:01:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'queued',
        attempt: 0,
        evidenceIds: [],
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('rehydrateWorkerRunRegistry', () => {
  it('restores a matching queued run as an executable queue', () => {
    const registry = rehydrateWorkerRunRegistry({
      projectId: 'project-1',
      taskGraphs: [graph()],
      runs: [run()],
    });

    expect(registry.queues.has('run-1')).toBe(true);
    expect(registry.queues.get('run-1')?.runnableTaskIds()).toEqual(['task-1']);
    expect(registry.recoveries).toEqual([]);
  });

  it('refuses a run whose task graph revision drifted', () => {
    const registry = rehydrateWorkerRunRegistry({
      projectId: 'project-1',
      taskGraphs: [graph(3)],
      runs: [run()],
    });

    expect(registry.queues.size).toBe(0);
    expect(registry.recoveries[0]).toMatchObject({
      runId: 'run-1',
      reason: 'task-graph-version-mismatch',
    });
  });

  it('does not install a queue when durable Worker facts drift from ProjectFile', () => {
    const registry = rehydrateWorkerRunRegistry({
      projectId: 'project-1',
      taskGraphs: [graph()],
      runs: [run()],
      consistency: {
        ok: false,
        projection: { lastSequence: 3, runs: {}, tasks: {} },
        issues: [{
          code: 'run-status-drift',
          runId: 'run-1',
          message: '状态漂移',
        }],
      },
    });

    expect(registry.queues.size).toBe(0);
    expect(registry.recoveries[0]).toMatchObject({
      runId: 'run-1',
      reason: 'event-stream-drift',
    });
  });

  it('does not automatically resume a run with an unfinished worker lease', () => {
    const registry = rehydrateWorkerRunRegistry({
      projectId: 'project-1',
      taskGraphs: [graph()],
      runs: [run({
        status: 'running',
        tasks: {
          'task-1': {
            taskId: 'task-1',
            status: 'running',
            attempt: 1,
            worktreeId: 'worktree-1',
            worktreePath: 'C:/worktrees/task-1',
            baseRevision: 'base-1',
            evidenceIds: [],
            updatedAt: '2026-09-01T00:02:00.000Z',
          },
        },
      })],
    });

    expect(registry.queues.size).toBe(0);
    expect(registry.recoveries[0]).toMatchObject({
      runId: 'run-1',
      reason: 'unfinished-worker-lease',
    });
  });

  it('runs a restored queue only when explicitly requested and forwards state/events updates', async () => {
    installWorkerRunRuntime({
      projectId: 'project-1',
      taskGraphs: [graph()],
      runs: [run()],
    });
    const updates: Array<{ status: string; eventTypes: string[] }> = [];

    const state = await runActiveWorkerRun(
      'run-1',
      {
        allocator: {
          allocate: async () => ({
            worktreeId: 'worktree-1',
            path: 'C:/worktrees/task-1',
            branch: 'worker/task-1',
            baseRevision: 'base-1',
          }),
        },
        executor: { execute: async () => ({ status: 'succeeded', evidenceIds: ['evidence-1'] }) },
      },
      ({ state: nextState, events }) => {
        updates.push({ status: nextState.status, eventTypes: events.map((event) => event.eventType) });
      },
    );

    expect(state.status).toBe('succeeded');
    expect(state.tasks['task-1'].status).toBe('succeeded');
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual(expect.objectContaining({ status: 'running' }));
    expect(updates[0].eventTypes).toEqual(expect.arrayContaining(['RunStarted', 'TaskStarted']));
    expect(updates[1]).toEqual(expect.objectContaining({ status: 'succeeded' }));
    expect(updates[1].eventTypes).toEqual(expect.arrayContaining(['TaskSucceeded', 'RunSucceeded']));
  });
});
