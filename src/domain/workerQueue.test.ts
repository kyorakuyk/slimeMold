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

  it('keeps host Evidence bindings when acceptance fails', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-failed-acceptance',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });

    const state = await runWorkerQueue(queue, {
      allocator: allocatorFor([]),
      executor: {
        execute: async () => ({
          status: 'failed' as const,
          error: '宿主验收失败：tests',
          evidenceIds: ['evidence-test', 'evidence-diff', 'evidence-policy'],
          acceptanceId: 'acceptance-failed-1',
        }),
      },
    });

    expect(state.tasks.a).toMatchObject({
      status: 'failed',
      evidenceIds: ['evidence-test', 'evidence-diff', 'evidence-policy'],
      acceptanceId: 'acceptance-failed-1',
    });
    const failedEvent = queue.drainEvents().find((event) => event.eventType === 'TaskFailed');
    expect(failedEvent?.payload).toMatchObject({
      evidenceIds: ['evidence-test', 'evidence-diff', 'evidence-policy'],
      acceptanceId: 'acceptance-failed-1',
    });
  });

  it('uses distinct event ids when a restored Run starts a new attempt', async () => {
    const first = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-retry-event-ids',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    first.drainEvents();
    await first.claimTask('a', allocatorFor([]));
    const firstTaskStarted = first.drainEvents().find((event) => event.eventType === 'TaskStarted');
    expect(firstTaskStarted).toBeDefined();

    const restored = restoreWorkerRunQueue({
      taskGraph: graph([task('a')]),
      state: {
        ...first.snapshot(),
        status: 'queued',
        tasks: {
          a: {
            ...first.snapshot().tasks.a,
            status: 'queued',
            worktreeId: undefined,
            worktreePath: undefined,
            branch: undefined,
            baseRevision: undefined,
          },
        },
      },
    });
    await restored.claimTask('a', allocatorFor([]));
    const retryTaskStarted = restored.drainEvents().find((event) => event.eventType === 'TaskStarted');

    expect(retryTaskStarted).toBeDefined();
    expect(retryTaskStarted?.eventId).not.toBe(firstTaskStarted?.eventId);
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

  it('flushes blocked events discovered during a no-runnable recovery check', async () => {
    const source = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-blocked-recovery',
      taskGraph: graph([task('a'), task('b', ['a'])]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const state = source.snapshot();
    state.status = 'partial';
    state.tasks.a = {
      ...state.tasks.a,
      status: 'failed',
      attempt: 1,
      error: '失败',
    };
    const restored = restoreWorkerRunQueue({ taskGraph: graph([task('a'), task('b', ['a'])]), state });
    const updates: string[][] = [];

    const result = await runWorkerQueue(restored, {
      allocator: allocatorFor([]),
      executor: { execute: async () => ({ status: 'succeeded', evidenceIds: ['unused'] }) },
      onTransition: ({ events }) => {
        updates.push(events.map((event) => event.eventType));
      },
    });

    expect(result.tasks.b.status).toBe('blocked');
    expect(updates).toEqual([expect.arrayContaining(['TaskBlocked'])]);
  });

  it('persists a running lease before invoking the Worker executor', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-lease-barrier',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const transitions: Array<{ status: string; taskStatus: string; events: string[] }> = [];
    let executorStarted = false;

    await runWorkerQueue(queue, {
      allocator: allocatorFor([]),
      executor: {
        execute: async () => {
          executorStarted = true;
          return { status: 'succeeded', evidenceIds: ['evidence-a'] };
        },
      },
      onTransition: ({ state, events }) => {
        transitions.push({
          status: state.status,
          taskStatus: state.tasks.a.status,
          events: events.map((event) => event.eventType),
        });
      },
    });

    expect(transitions[0]).toEqual(expect.objectContaining({ status: 'running', taskStatus: 'running' }));
    expect(transitions[0].events).toEqual(expect.arrayContaining(['RunStarted', 'TaskStarted']));
    expect(transitions[1]).toEqual(expect.objectContaining({ status: 'succeeded', taskStatus: 'succeeded' }));
    expect(executorStarted).toBe(true);
  });

  it('persists the assigned branch so the host can restore the worktree safely', async () => {
    const queue = createWorkerRunQueue({ projectId: 'project-1', runId: 'run-branch', taskGraph: graph([task('task-a')]), now: '2026-09-01T00:00:01.000Z' });
    const lease = await queue.claimTask('task-a', allocatorFor([]));

    expect(lease).not.toBeNull();
    expect(queue.snapshot().tasks['task-a']).toEqual(expect.objectContaining({
      worktreeId: 'worktree-task-a',
      worktreePath: 'C:/worktrees/task-a',
      branch: 'worker/task-a',
    }));
  });

  it('starts and closes the Worker side-effect receipt around executor execution', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-side-effect',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const order: string[] = [];
    const receiptRecord = {
      idempotencyKey: 'worker-execution:run-side-effect:a:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-a',
      inputHash: 'run-side-effect:a:1:base-revision-1',
      runId: 'run-side-effect',
      taskId: 'a',
      status: 'started' as const,
      recovery: 'retry' as const,
    };

    await runWorkerQueue(queue, {
      allocator: allocatorFor([]),
      sideEffects: {
        start: async () => {
          order.push('effect-start');
          return receiptRecord;
        },
        complete: async () => {
          order.push('effect-receipt');
          return {
            ...receiptRecord,
            status: 'receipt' as const,
            recovery: 'skip' as const,
            receipt: { receiptId: `${receiptRecord.idempotencyKey}:receipt`, observedAt: '2026-09-01T00:00:01.000Z' },
          };
        },
      },
      executor: {
        execute: async () => {
          order.push('executor');
          return { status: 'succeeded', evidenceIds: ['evidence-a'] };
        },
      },
      onTransition: ({ state }) => {
        order.push(state.status === 'running' ? 'persist-running' : 'persist-succeeded');
      },
    });

    expect(order).toEqual([
      'persist-running',
      'effect-start',
      'executor',
      'effect-receipt',
      'persist-succeeded',
    ]);
  });

  it('marks a started side effect unknown when the Worker executor throws', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-side-effect-error',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const started = {
      idempotencyKey: 'worker-execution:run-side-effect-error:a:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-a',
      inputHash: 'input-a',
      runId: 'run-side-effect-error',
      taskId: 'a',
      status: 'started' as const,
      recovery: 'retry' as const,
    };
    const unknownReasons: string[] = [];

    const state = await runWorkerQueue(queue, {
      allocator: allocatorFor([]),
      sideEffects: {
        start: async () => started,
        complete: async () => ({ ...started, status: 'receipt' as const, recovery: 'skip' as const }),
        markUnknown: async (_record, reason) => {
          unknownReasons.push(reason);
          return { ...started, status: 'unknown' as const, recovery: 'needs-user' as const, unknownReason: reason };
        },
      },
      executor: { execute: async () => { throw new Error('Codex 进程异常退出'); } },
    });

    expect(state.status).toBe('partial');
    expect(state.tasks.a.status).toBe('failed');
    expect(unknownReasons).toEqual(['worker-execution-failed-before-receipt']);
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
