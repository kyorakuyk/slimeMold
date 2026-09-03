import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';
import { replayDomainEvents, type DomainEvent } from './contracts';
import { clearProjectEventBuffer, getPendingProjectEvents, recordProjectEvents } from '../projectControl/eventBuffer';
import {
  createWorkerRunQueue,
  restoreWorkerRunQueue,
  runWorkerQueue,
  type WorkerExecutionResult,
  type WorkerTaskLease,
  type WorkerWorktreeAllocator,
} from './workerQueue';
import { createAttemptId, createTaskExecutionId } from './execution';

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

  it('assigns stable task execution and attempt ids across retries', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-lineage',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const taskExecutionId = createTaskExecutionId('run-lineage', 'a');
    const queuedEvent = queue.drainEvents().find((event) => event.eventType === 'TaskQueued');

    expect(queuedEvent?.payload).toMatchObject({
      runId: 'run-lineage',
      taskId: 'a',
      taskExecutionId,
    });

    const firstLease = await queue.claimTask('a', allocatorFor([]));
    const firstAttemptId = createAttemptId(taskExecutionId, 1);
    const firstStarted = queue.drainEvents().find((event) => event.eventType === 'TaskStarted');
    expect(firstLease).toMatchObject({ taskExecutionId, attempt: 1, attemptId: firstAttemptId });
    expect(firstStarted?.payload).toMatchObject({ taskExecutionId, attemptId: firstAttemptId, attempt: 1 });

    queue.markFailed('a', '第一次失败', '2026-09-01T00:00:02.000Z', [], undefined, firstLease!.attemptId);
    queue.drainEvents();
    const failed = queue.snapshot();
    const restored = restoreWorkerRunQueue({
      taskGraph: graph([task('a')]),
      state: {
        ...failed,
        status: 'queued',
        tasks: {
          a: {
            ...failed.tasks.a,
            status: 'queued',
            worktreeId: undefined,
            worktreePath: undefined,
            branch: undefined,
            baseRevision: undefined,
          },
        },
      },
    });

    const secondLease = await restored.claimTask('a', allocatorFor([]));
    const secondAttemptId = createAttemptId(taskExecutionId, 2);
    const secondStarted = restored.drainEvents().find((event) => event.eventType === 'TaskStarted');
    expect(secondLease).toMatchObject({ taskExecutionId, attempt: 2, attemptId: secondAttemptId });
    expect(secondStarted?.payload).toMatchObject({ taskExecutionId, attemptId: secondAttemptId, attempt: 2 });
    expect(secondStarted?.eventId).not.toBe(firstStarted?.eventId);
  });

  it('rejects stale completion from an older attempt', () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-fence',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const taskExecutionId = createTaskExecutionId('run-fence', 'a');
    const staleAttemptId = createAttemptId(taskExecutionId, 1);
    const currentAttemptId = createAttemptId(taskExecutionId, 2);
    const staleQueue = restoreWorkerRunQueue({
      taskGraph: graph([task('a')]),
      state: {
        ...queue.snapshot(),
        status: 'running',
        tasks: {
          a: {
            ...queue.snapshot().tasks.a,
            status: 'running',
            attempt: 2,
            currentAttemptId,
            worktreeId: 'worktree-attempt-2',
            worktreePath: 'C:/worktrees/attempt-2',
            branch: 'worker/attempt-2',
            baseRevision: 'base-2',
          },
        },
      },
    });

    expect(() => staleQueue.markSucceeded(
      'a',
      ['late-evidence'],
      '2026-09-01T00:00:02.000Z',
      'late-acceptance',
      staleAttemptId,
    )).toThrow(/Attempt|attempt|过期/);
    expect(staleQueue.snapshot().tasks.a).toMatchObject({ status: 'running', attempt: 2, currentAttemptId });
  });

  it('rebuilds execution and attempt projections from serialized Worker events', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-replay',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    clearProjectEventBuffer('project-1');
    recordProjectEvents('project-1', queue.drainEvents());
    const lease = await queue.claimTask('a', allocatorFor([]));
    expect(lease).not.toBeNull();
    recordProjectEvents('project-1', queue.drainEvents());
    queue.markSucceeded('a', ['evidence-replay'], '2026-09-01T00:00:02.000Z', 'acceptance-replay', lease!.attemptId);
    recordProjectEvents('project-1', queue.drainEvents());

    const eventLog = getPendingProjectEvents('project-1');
    const replayed = replayDomainEvents(JSON.parse(JSON.stringify(eventLog)) as DomainEvent[]);
    clearProjectEventBuffer('project-1');
    const taskExecutionId = createTaskExecutionId('run-replay', 'a');
    const attemptId = createAttemptId(taskExecutionId, 1);

    expect(replayed.taskExecutions[taskExecutionId]).toMatchObject({
      status: 'succeeded',
      currentAttemptId: attemptId,
      attemptIds: [attemptId],
      evidenceIds: ['evidence-replay'],
      acceptanceId: 'acceptance-replay',
    });
    expect(replayed.attempts[attemptId]).toMatchObject({
      taskExecutionId,
      attempt: 1,
      status: 'succeeded',
      evidenceIds: ['evidence-replay'],
      acceptanceId: 'acceptance-replay',
    });
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
    queue.markSucceeded('a', ['evidence-a'], '2026-09-01T00:00:02.000Z', undefined, lease!.attemptId);

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

  it('stops claiming new tasks and publishing transitions after cancellation', async () => {
    const controller = new AbortController();
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-cancel',
      taskGraph: graph([task('a'), task('b')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const allocated: string[] = [];
    let executorCalls = 0;
    const transitions: string[] = [];

    await expect(runWorkerQueue(queue, {
      concurrency: 1,
      allocator: {
        allocate: async ({ task: queuedTask }) => {
          allocated.push(queuedTask.id);
          return {
            worktreeId: `worktree-${queuedTask.id}`,
            path: `C:/worktrees/${queuedTask.id}`,
            branch: `worker/${queuedTask.id}`,
            baseRevision: 'base-1',
          };
        },
      },
      executor: {
        execute: async (_lease, { signal } = {}) => {
          executorCalls += 1;
          expect(signal).toBe(controller.signal);
          controller.abort();
          return { status: 'succeeded', evidenceIds: ['should-not-persist'] };
        },
      },
      signal: controller.signal,
      onTransition: ({ state }) => {
        transitions.push(state.status);
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(allocated).toEqual(['a']);
    expect(executorCalls).toBe(1);
    expect(transitions).toEqual(['running']);
    expect(queue.snapshot().tasks.a.status).toBe('running');
    expect(queue.drainEvents()).toEqual([]);
  });

  it('retains drained events when transition persistence fails', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-transition-failure',
      taskGraph: graph([task('a')]),
      now: '2026-09-03T00:00:00.000Z',
    });
    await expect(runWorkerQueue(queue, {
      concurrency: 1,
      allocator: { allocate: async () => ({ worktreeId: 'wt', path: 'C:/wt', branch: 'worker/wt', baseRevision: 'base' }) },
      executor: { execute: async () => ({ status: 'succeeded' as const, evidenceIds: ['e'] }) },
      onTransition: async () => { throw new Error('persistence unavailable'); },
    })).rejects.toThrow('persistence unavailable');
    expect(queue.drainEvents().map((event) => event.eventType)).toEqual(['RunCreated', 'TaskQueued', 'RunStarted', 'TaskStarted']);
  });

  it('rejects cyclic task graphs before creating a queue', () => {
    expect(() => createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-cycle',
      taskGraph: graph([task('a', ['b']), task('b', ['a'])]),
      now: '2026-09-01T00:00:01.000Z',
    })).toThrow(/循环依赖/);
  });

  it('rejects task ids whose whitespace normalization would collide', () => {
    expect(() => createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-canonical',
      taskGraph: graph([task('a'), task(' a')]),
      now: '2026-09-01T00:00:01.000Z',
    })).toThrow(/canonical|空白/);
  });

  it('rejects a restored task whose attempt token belongs to another execution', () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-lineage-restore',
      taskGraph: graph([task('a')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    const wrongExecutionId = createTaskExecutionId('other-run', 'a');

    expect(() => restoreWorkerRunQueue({
      taskGraph: graph([task('a')]),
      state: {
        ...queue.snapshot(),
        status: 'running',
        tasks: {
          a: {
            ...queue.snapshot().tasks.a,
            status: 'running',
            attempt: 1,
            currentAttemptId: createAttemptId(wrongExecutionId, 1),
          },
        },
      },
    })).toThrow(/lineage|attempt/);
  });

  it('rejects case-variant reuse of the same Windows worktree path', async () => {
    let calls = 0;
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-case-path',
      now: '2026-09-03T00:00:00.000Z',
      taskGraph: graph([task('a'), task('b')]),
    });
    const allocator: WorkerWorktreeAllocator = {
      allocate: async () => ({
        worktreeId: `worktree-${++calls}`,
        path: calls === 1 ? 'C:/Worktrees/Shared' : 'c:/worktrees/shared',
        branch: `worker-${calls}`,
        baseRevision: 'base-1',
      }),
    };

    await queue.claimTask('a', allocator);
    const secondLease = await queue.claimTask('b', allocator);
    expect(secondLease).toBeNull();
    expect(queue.snapshot().tasks.b.status).toBe('failed');
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

  it('keeps allocation failure replayable and rejects invalid queued attempts', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-allocation-failure',
      taskGraph: graph([task('a')]),
      now: '2026-09-03T00:00:00.000Z',
    });
    const transitions: DomainEvent[] = [];
    const failed = await runWorkerQueue(queue, {
      allocator: { allocate: async () => { throw new Error('allocator unavailable'); } },
      executor: { execute: async () => ({ status: 'succeeded' as const }) },
      concurrency: 1,
      onTransition: async ({ events }) => { transitions.push(...events); },
    });
    expect(failed.tasks.a.status).toBe('failed');
    expect(transitions.map((event) => event.eventType)).toEqual(['RunCreated', 'TaskQueued', 'RunStarted', 'TaskStarted', 'TaskFailed', 'RunPartial']);
    expect(() => restoreWorkerRunQueue({ taskGraph: graph([task('a')]), state: { ...failed, tasks: { a: { ...failed.tasks.a, status: 'queued', attempt: -1 } } } })).toThrow(/attempt/);
    expect(() => restoreWorkerRunQueue({ taskGraph: graph([task('a')]), state: { ...failed, tasks: { a: { ...failed.tasks.a, status: 'queued', attempt: Number.MAX_SAFE_INTEGER + 1 } } } })).toThrow(/attempt/);
  });
});
