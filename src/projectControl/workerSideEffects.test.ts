import { describe, expect, it } from 'vitest';
import type { WorkerExecutionResult, WorkerTaskLease } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { ProjectTaskGraph } from './types';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import {
  buildWorkerRunRecoveryPlan,
  createWorkerSideEffectRecorder,
  decideWorkerRunRecovery,
  applyWorkerRunRecoveryDecision,
} from './workerSideEffects';

const lease: WorkerTaskLease = {
  runId: 'run-1',
  orchestrationId: 'orch-1',
  task: {
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
  },
  assignment: {
    worktreeId: 'worktree-1',
    path: 'C:/worktrees/task-1',
    branch: 'worker/run-1/task-1/a1',
    baseRevision: 'base-1',
  },
  attempt: 1,
  taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
  attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
};

const succeeded: WorkerExecutionResult = {
  status: 'succeeded',
  evidenceIds: ['evidence-1'],
};

describe('worker side-effect recorder', () => {
  it('records a started Worker execution before completion and closes it with a host receipt', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository, () => '2026-09-01T00:01:00.000Z');

    const started = await recorder.start(lease);
    expect(started).toMatchObject({
      idempotencyKey: `worker-execution:${lease.attemptId}`,
      kind: 'worker-execution',
      target: 'worktree-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      status: 'started',
      recovery: 'retry',
    });

    const completed = await recorder.complete(started, succeeded);
    expect(completed).toMatchObject({
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: `worker-execution:${lease.attemptId}:receipt`,
        observedAt: '2026-09-01T00:01:00.000Z',
        outcome: 'succeeded',
      },
    });
    expect((await repository.read()).journal.entries).toEqual([completed]);
  });

  it('uses canonical attempt identity instead of delimiter-ambiguous run/task keys', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository, () => '2026-09-01T00:01:00.000Z');
    const leaseA = {
      ...lease,
      runId: 'run:a',
      task: { ...lease.task, id: 'b' },
      taskExecutionId: createTaskExecutionId('run:a', 'b'),
      attemptId: createAttemptId(createTaskExecutionId('run:a', 'b'), 1),
    };
    const leaseB = {
      ...lease,
      runId: 'run',
      task: { ...lease.task, id: 'a:b' },
      taskExecutionId: createTaskExecutionId('run', 'a:b'),
      attemptId: createAttemptId(createTaskExecutionId('run', 'a:b'), 1),
    };

    const first = await recorder.start(leaseA);
    const second = await recorder.start(leaseB);

    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it('records a failed Worker result in the completed side-effect receipt', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const started = await recorder.start(lease);

    const completed = await recorder.complete(started, {
      status: 'failed',
      error: 'host acceptance failed',
    });

    expect(completed).toMatchObject({
      status: 'receipt',
      receipt: { outcome: 'failed', error: 'host acceptance failed' },
    });
  });

  it('does not let a late completion promote a recovered unknown effect', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const started = await recorder.start(lease);
    await recorder.recoverInterruptedRun('run-1');

    const late = await recorder.complete(started, { status: 'succeeded' });
    expect(late.status).toBe('unknown');
    expect((await repository.read()).journal.entries[0].status).toBe('unknown');
  });

  it('turns an unclosed Worker execution into unknown and exposes explicit recovery decisions', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository, () => '2026-09-01T00:02:00.000Z');
    const started = await recorder.start(lease);

    const journal = await recorder.recoverInterruptedRun('run-1');
    const unknown = journal.entries[0];
    expect(unknown).toMatchObject({ status: 'unknown', recovery: 'needs-user', unknownReason: 'worker-run-restarted' });

    const plan = buildWorkerRunRecoveryPlan('run-1', journal);
    expect(plan.requiresUser).toBe(true);
    expect(plan.allowedDecisions).toEqual(['inspect', 'retry', 'skip']);
    expect(plan.effectKeys).toEqual([started.idempotencyKey]);

    expect(decideWorkerRunRecovery(plan, 'inspect', '先检查 worktree 和远端状态')).toMatchObject({
      runId: 'run-1',
      decision: 'inspect',
      requiresNewAttempt: false,
    });
    expect(decideWorkerRunRecovery(plan, 'retry', '确认旧执行没有产生可交付结果')).toMatchObject({
      decision: 'retry',
      requiresNewAttempt: true,
    });
    expect(decideWorkerRunRecovery(plan, 'skip', '保留当前失败结果，不重做副作用')).toMatchObject({
      decision: 'skip',
      requiresNewAttempt: false,
    });
  });

  it('creates a new queued attempt for retry and blocks dependents for skip', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository, () => '2026-09-01T00:03:00.000Z');
    const started = await recorder.start(lease);
    await recorder.recoverInterruptedRun('run-1');
    await repository.record({
      idempotencyKey: 'worker-execution:run-1:task-3:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-3',
      inputHash: 'input-3',
      runId: 'run-1',
      taskId: 'task-3',
      taskExecutionId: createTaskExecutionId('run-1', 'task-3'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-3'), 1),
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: 'receipt-3',
        observedAt: '2026-09-01T00:02:00.000Z',
        outcome: 'succeeded',
        outputHash: 'output-3',
      },
    });
    const journalWithReceipt = (await repository.read()).journal;
    const plan = buildWorkerRunRecoveryPlan('run-1', journalWithReceipt);
    const graph: ProjectTaskGraph = {
      version: 1,
      id: 'graph-1',
      sessionId: 'session-1',
      architectureId: 'architecture-1',
      graphVersion: 1,
      tasks: [lease.task, {
        ...lease.task,
        id: 'task-2',
        title: '依赖任务',
        dependsOn: ['task-1'],
      }, {
        ...lease.task,
        id: 'task-3',
        title: '已完成任务',
        dependsOn: [],
      }],
      approval: 'approved',
      approvedBy: 'user',
      approvedAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const state = {
      version: 1 as const,
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'running' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
          status: 'running' as const,
          attempt: 1,
          currentAttemptId: lease.attemptId,
          worktreeId: 'worktree-1',
          worktreePath: 'C:/worktrees/task-1',
          baseRevision: 'base-1',
          evidenceIds: [],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
        'task-2': {
          taskId: 'task-2',
          status: 'queued' as const,
          attempt: 0,
          evidenceIds: [],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
        'task-3': {
          ...lease.task,
          taskId: 'task-3',
          status: 'succeeded' as const,
          attempt: 1,
          evidenceIds: ['evidence-3'],
          acceptanceId: 'acceptance-3',
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    };

    const legacyPlan = { ...plan } as typeof plan & { recoverableEffects?: undefined };
    delete legacyPlan.recoverableEffects;
    const legacyRetried = applyWorkerRunRecoveryDecision({
      plan: legacyPlan,
      state,
      taskGraph: graph,
      decision: 'retry',
      reason: 'legacy plan fallback',
      now: '2026-09-01T00:01:30.000Z',
    });
    expect(legacyRetried.status).toBe('queued');

    const retried = applyWorkerRunRecoveryDecision({
      plan,
      state,
      taskGraph: graph,
      decision: 'retry',
      reason: '确认旧执行没有产生可交付结果',
      now: '2026-09-01T00:04:00.000Z',
    });
    expect(retried.status).toBe('queued');
    expect(retried.tasks['task-1']).toMatchObject({ status: 'queued', attempt: 1 });
    expect(retried.tasks['task-1'].worktreePath).toBeUndefined();
    expect(retried.tasks['task-3']).toMatchObject({ status: 'succeeded', acceptanceId: 'acceptance-3' });

    expect(() => applyWorkerRunRecoveryDecision({
      plan,
      state: retried,
      taskGraph: graph,
      decision: 'retry',
      reason: '旧计划不能再次作用于 queued retry',
      now: '2026-09-01T00:05:00.000Z',
    })).toThrow(/没有绑定可处理的任务/);

    const staleCurrentAttemptId = createAttemptId(createTaskExecutionId('run-1', 'task-1'), 2);
    expect(() => applyWorkerRunRecoveryDecision({
      plan,
      state: {
        ...state,
        tasks: {
          ...state.tasks,
          'task-1': { ...state.tasks['task-1'], attempt: 2, currentAttemptId: staleCurrentAttemptId },
        },
      },
      taskGraph: graph,
      decision: 'retry',
      reason: '旧 attempt 已被新的执行取代',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/没有绑定可处理的任务/);

    const skipped = applyWorkerRunRecoveryDecision({
      plan,
      state,
      taskGraph: graph,
      decision: 'skip',
      reason: '保留当前结果，不重做副作用',
      now: '2026-09-01T00:04:00.000Z',
    });
    expect(skipped.status).toBe('partial');
    expect(skipped.tasks['task-1']).toMatchObject({ status: 'failed' });
    expect(skipped.tasks['task-2']).toMatchObject({ status: 'blocked' });
    expect(started.idempotencyKey).toBe(`worker-execution:${lease.attemptId}`);
  });
});
