import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';
import {
  createWorkerRunQueue,
  restoreWorkerRunQueue,
  runWorkerQueue,
  type WorkerExecutionResult,
  type WorkerTaskLease,
  type WorkerWorktreeAllocator,
} from './workerQueue';

function task(id: string, dependsOn: string[] = []): ProjectTask {
  return {
    version: 1,
    id,
    architectureId: 'architecture-1',
    title: `任务 ${id}`,
    description: `执行 ${id}`,
    moduleId: `module-${id}`,
    scope: [`src/${id}`],
    dependsOn,
    acceptanceCriteria: [`${id} 通过测试`],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function graph(tasks: ProjectTask[]): ProjectTaskGraph {
  return {
    version: 1,
    id: 'task-graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 3,
    tasks,
    approval: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function allocatorFor(calls: string[]): WorkerWorktreeAllocator {
  return {
    allocate: async ({ task: queuedTask }) => {
      calls.push(queuedTask.id);
      return {
        worktreeId: `worktree-${queuedTask.id}`,
        path: `C:/worktrees/${queuedTask.id}`,
        branch: `worker/${queuedTask.id}`,
        baseRevision: 'base-revision-1',
      };
    },
  };
}

describe('WorkerTaskQueue', () => {
  it('queues an approved graph and exposes only dependency-free tasks', () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-1',
      taskGraph: graph([task('a'), task('b', ['a']), task('c')]),
      now: '2026-09-01T00:00:01.000Z',
    });

    expect(queue.snapshot().status).toBe('queued');
    expect(queue.runnableTaskIds()).toEqual(['a', 'c']);
    expect(queue.drainEvents().map((event) => event.eventType)).toEqual([
      'RunCreated',
      'TaskQueued',
      'TaskQueued',
      'TaskQueued',
    ]);
  });

  it('gives every claimed task its own worktree and continues independent tasks after failure', async () => {
    const allocated: string[] = [];
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-1',
      taskGraph: graph([task('a'), task('b', ['a']), task('c')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const leases: WorkerTaskLease[] = [];
    const executor = {
      execute: async (lease: WorkerTaskLease): Promise<WorkerExecutionResult> => {
        leases.push(lease);
        return lease.task.id === 'a'
          ? { status: 'failed', error: '编译失败' }
          : { status: 'succeeded', evidenceIds: [`evidence-${lease.task.id}`] };
      },
    };

    const state = await runWorkerQueue(queue, {
      allocator: allocatorFor(allocated),
      executor,
    });

    expect(allocated).toEqual(['a', 'c']);
    expect(new Set(leases.map((lease) => lease.assignment.worktreeId)).size).toBe(2);
    expect(state.tasks.a.status).toBe('failed');
    expect(state.tasks.c.status).toBe('succeeded');
    expect(state.tasks.b.status).toBe('blocked');
    expect(state.status).toBe('partial');
    const eventTypes = queue.drainEvents().map((event) => event.eventType);
    expect(eventTypes).toContain('TaskStarted');
    expect(eventTypes).toContain('TaskFailed');
    expect(eventTypes).toContain('TaskSucceeded');
    expect(eventTypes).toContain('TaskBlocked');
    expect(eventTypes).toContain('RunPartial');
  });

  it('restores a queue snapshot and resumes only the remaining runnable task', async () => {
    const firstAllocations: string[] = [];
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-1',
      taskGraph: graph([task('a'), task('b', ['a'])]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const lease = await queue.claimTask('a', allocatorFor(firstAllocations));
    expect(lease).not.toBeNull();
    queue.markSucceeded('a', ['evidence-a'], '2026-09-01T00:00:02.000Z');

    const restored = restoreWorkerRunQueue({
      taskGraph: graph([task('a'), task('b', ['a'])]),
      state: queue.snapshot(),
    });
    const resumedAllocations: string[] = [];
    const state = await runWorkerQueue(restored, {
      allocator: allocatorFor(resumedAllocations),
      executor: { execute: async () => ({ status: 'succeeded', evidenceIds: ['evidence-b'] }) },
    });

    expect(firstAllocations).toEqual(['a']);
    expect(resumedAllocations).toEqual(['b']);
    expect(state.tasks.a.status).toBe('succeeded');
    expect(state.tasks.b.status).toBe('succeeded');
    expect(state.status).toBe('succeeded');
  });

  it('rejects cyclic task graphs before creating a queue', () => {
    expect(() => createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-cycle',
      taskGraph: graph([task('a', ['b']), task('b', ['a'])]),
      now: '2026-09-01T00:00:01.000Z',
    })).toThrow(/循环依赖/);
  });

  it('rejects an empty task graph instead of creating a no-op run', () => {
    expect(() => createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-empty',
      taskGraph: graph([]),
      now: '2026-09-01T00:00:01.000Z',
    })).toThrow(/任务图不能为空/);
  });

  it('does not emit RunStarted twice after an event batch is drained', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-2',
      taskGraph: graph([task('a'), task('c')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const allocator = allocatorFor([]);
    expect(await queue.claimTask('a', allocator)).not.toBeNull();
    queue.drainEvents();
    expect(await queue.claimTask('c', allocator)).not.toBeNull();
    expect(queue.drainEvents().filter((event) => event.eventType === 'RunStarted')).toHaveLength(0);
  });

  it('fails closed when an allocator reuses a worktree for another task in the same run', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-shared-worktree',
      taskGraph: graph([task('a'), task('c')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const sharedAllocator: WorkerWorktreeAllocator = {
      allocate: async () => ({
        worktreeId: 'worktree-shared',
        path: 'C:/worktrees/shared',
        branch: 'worker/shared',
        baseRevision: 'base-revision-1',
      }),
    };

    const state = await runWorkerQueue(queue, {
      allocator: sharedAllocator,
      executor: { execute: async () => ({ status: 'succeeded', evidenceIds: ['evidence'] }) },
      concurrency: 1,
    });

    expect(state.tasks.a.status).toBe('succeeded');
    expect(state.tasks.c.status).toBe('failed');
    expect(state.tasks.c.error).toMatch(/worktree.*复用|占用/);
  });
});
