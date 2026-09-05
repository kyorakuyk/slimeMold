import { describe, expect, it, vi } from 'vitest';
import type { ProjectTaskGraph } from './types';
import type {
  WorkerExecutionResult,
  WorkerRunQueueState,
  WorkerWorktreeAllocator,
  WorkerExecutor,
} from '../domain/workerQueue';
import { installWorkerRunRuntime, clearWorkerRunRuntime } from './workerRunRuntime';
import { createProjectWorkerRunCoordinator, workerWorktreePathFor } from './workerRunCoordinator';

function graph(): ProjectTaskGraph {
  return {
    version: 1,
    sessionId: 'session-1',
    id: 'graph-1',
    architectureId: 'architecture-1',
    graphVersion: 1,
    approval: 'approved',
    tasks: [{
      version: 1,
      id: 'task-1',
      architectureId: 'architecture-1',
      title: '实现任务',
      description: '完成实现',
      moduleId: 'module-1',
      scope: ['src/feature.ts'],
      dependsOn: [],
      acceptanceCriteria: ['测试通过'],
      category: 'implementation',
      status: 'approved',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function queuedRun(): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orchestration-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'queued',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'queued',
        attempt: 0,
        evidenceIds: [],
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  };
}

function dependencies(): { allocator: WorkerWorktreeAllocator; executor: WorkerExecutor } {
  return {
    allocator: {
      allocate: vi.fn(async () => ({
        worktreeId: 'worktree-1',
        path: 'C:/worktrees/task-1',
        branch: 'worker/run-1/task-1/a1',
        baseRevision: 'base-1',
      })),
    },
    executor: {
      execute: vi.fn(async (): Promise<WorkerExecutionResult> => ({ status: 'succeeded', evidenceIds: ['evidence-1'] })),
    },
  };
}

describe('createProjectWorkerRunCoordinator', () => {
  it('allocates worker paths outside the main project root', () => {
    const path = workerWorktreePathFor('C:/projects/slimeMold', {
      projectId: 'project-1',
      runId: 'run/one',
      task: graph().tasks[0],
      attempt: 2,
    });

    const identity = path.slice(path.lastIndexOf('/') + 1);
    expect(identity).toMatch(/^w-[0-9a-f]+$/);
    expect(path).toBe(`C:/projects/slimeMold-workers/${identity}`);
    expect(identity).not.toContain('%');
    expect(path.startsWith('C:/projects/slimeMold/')).toBe(false);
  });

  it('does not collide when run ids normalize to the same safe segment', () => {
    const pathA = workerWorktreePathFor('C:/projects/slimeMold', {
      projectId: 'project-1',
      runId: 'run/a',
      task: graph().tasks[0],
      attempt: 1,
    });
    const pathB = workerWorktreePathFor('C:/projects/slimeMold', {
      projectId: 'project-1',
      runId: 'run-a',
      task: graph().tasks[0],
      attempt: 1,
    });

    expect(pathA).not.toBe(pathB);
  });

  it('runs a restored queue and persists each state/event transition together', async () => {
    const state = queuedRun();
    installWorkerRunRuntime({ projectId: 'project-1', taskGraphs: [graph()], runs: [state] });
    const persisted: Array<{ state: WorkerRunQueueState; eventTypes: string[] }> = [];
    const deps = dependencies();
    const coordinator = createProjectWorkerRunCoordinator({
      projectId: 'project-1',
      runs: [state],
      persistTransition: ({ state: nextState, events }) => {
        persisted.push({ state: nextState, eventTypes: events.map((event) => event.eventType) });
      },
      ...deps,
    });

    const result = await coordinator.run('run-1');

    expect(result.status).toBe('succeeded');
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toEqual(expect.objectContaining({
      state: expect.objectContaining({ status: 'running' }),
      eventTypes: expect.arrayContaining(['RunStarted', 'TaskStarted']),
    }));
    expect(persisted[1]).toEqual(expect.objectContaining({
      state: expect.objectContaining({ status: 'succeeded' }),
      eventTypes: expect.arrayContaining(['TaskSucceeded', 'RunSucceeded']),
    }));
    expect(deps.allocator.allocate).toHaveBeenCalledTimes(1);
    expect(deps.executor.execute).toHaveBeenCalledTimes(1);
    clearWorkerRunRuntime();
  });

  it('rejects concurrent starts for the same Run', async () => {
    const state = queuedRun();
    installWorkerRunRuntime({ projectId: 'project-1', taskGraphs: [graph()], runs: [state] });
    let release!: () => void;
    const deps = dependencies();
    deps.executor.execute = vi.fn(() => new Promise<WorkerExecutionResult>((resolve) => {
      release = () => resolve({ status: 'succeeded', evidenceIds: ['evidence-1'] });
    }));
    const coordinator = createProjectWorkerRunCoordinator({
      projectId: 'project-1',
      runs: [state],
      persistTransition: vi.fn(),
      ...deps,
    });

    const first = coordinator.run('run-1');
    await vi.waitFor(() => expect(deps.executor.execute).toHaveBeenCalledTimes(1));
    await expect(coordinator.run('run-1')).rejects.toThrow('Run 正在执行');
    release();
    await first;
    clearWorkerRunRuntime();
  });

  it('fails closed before allocating a worktree when the fact-source audit fails', async () => {
    const state = queuedRun();
    installWorkerRunRuntime({ projectId: 'project-1', taskGraphs: [graph()], runs: [state] });
    const deps = dependencies();
    const coordinator = createProjectWorkerRunCoordinator({
      projectId: 'project-1',
      runs: [state],
      persistTransition: vi.fn(),
      assertConsistency: () => {
        throw new Error('Worker 事件流与 ProjectFile 不一致');
      },
      ...deps,
    });

    await expect(coordinator.run('run-1')).rejects.toThrow('Worker 事件流与 ProjectFile 不一致');
    expect(deps.allocator.allocate).not.toHaveBeenCalled();
    expect(deps.executor.execute).not.toHaveBeenCalled();
    clearWorkerRunRuntime();
  });
});
