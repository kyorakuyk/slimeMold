import { describe, expect, it } from 'vitest';
import { createSideEffect, startSideEffect } from '../domain/contracts';
import type { WorkerExecutionResult, WorkerTaskLease } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { ProjectTaskGraph } from './types';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import {
  buildWorkerRunRecoveryPlan,
  createWorkerSideEffectRecorder,
  createWorkerEvidenceVerifier,
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
    const recorder = createWorkerSideEffectRecorder(
      repository,
      () => '2026-09-01T00:01:00.000Z',
      async ({ record, evidenceIds }) => {
        expect(record.taskExecutionId).toBe(lease.taskExecutionId);
        expect(record.attemptId).toBe(lease.attemptId);
        expect(evidenceIds).toEqual(['evidence-1']);
      },
    );

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

  it('keeps start safe when passed as an unbound callback', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const { start } = recorder;

    await expect(start(lease)).resolves.toMatchObject({ status: 'started' });
  });

  it('upgrades a lineage-bearing legacy planned alias to the canonical started record', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const legacyKey = `worker-execution:${lease.runId}:${lease.task.id}:attempt-${lease.attempt}`;
    await repository.record(createSideEffect({
      idempotencyKey: legacyKey,
      kind: 'worker-execution',
      target: lease.assignment.worktreeId,
      inputHash: [
        lease.runId,
        lease.task.id,
        lease.task.version,
        lease.attempt,
        lease.assignment.baseRevision,
      ].join(':'),
      runId: lease.runId,
      taskId: lease.task.id,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
    }));

    const started = await recorder.start(lease);

    expect(started).toMatchObject({
      idempotencyKey: `worker-execution:${lease.attemptId}`,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
      status: 'started',
    });
    expect((await repository.read()).journal.entries).toHaveLength(1);
  });

  it('atomically rejects a concurrent start for the same attempt', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);

    const results = await Promise.allSettled([
      recorder.start(lease),
      recorder.start(lease),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await repository.read()).journal.entries).toHaveLength(1);
    expect((await repository.read()).journal.entries[0].status).toBe('started');
  });

  it('binds a pending canonical claim to the exact worker path and branch', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    await repository.record(createSideEffect({
      idempotencyKey: `worker-execution:${lease.attemptId}`,
      kind: 'worker-execution',
      target: lease.assignment.worktreeId,
      inputHash: JSON.stringify([
        lease.runId,
        lease.task.id,
        lease.task.version,
        lease.attempt,
        lease.assignment.baseRevision,
      ]),
      runId: lease.runId,
      taskId: lease.task.id,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
    }));

    const movedLease = {
      ...lease,
      assignment: {
        ...lease.assignment,
        path: 'C:/worktrees/other',
        branch: 'worker/other',
      },
    };
    await expect(recorder.start(movedLease)).rejects.toThrow(/idempotencyKey|inputHash/);
    expect((await repository.read()).journal.entries[0].status).toBe('planned');
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

  it('rejects direct completion or unknown marking for non-worker effects', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const foreign = startSideEffect(createSideEffect({
      idempotencyKey: 'cleanup:foreign',
      kind: 'worktree-cleanup',
      target: 'worktree-1',
      inputHash: 'cleanup-input',
      runId: 'run-1',
      taskId: 'task-1',
    }));
    await repository.record(foreign);

    await expect(recorder.complete(foreign, { status: 'failed', error: 'foreign' }))
      .rejects.toThrow(/worker-execution/);
    await expect(recorder.markUnknown!(foreign, 'foreign'))
      .rejects.toThrow(/worker-execution/);
    expect((await repository.read()).journal.entries[0]).toMatchObject({
      idempotencyKey: 'cleanup:foreign',
      status: 'started',
    });
  });

  it('rejects a succeeded receipt without non-empty host Evidence provenance', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const started = await recorder.start(lease);

    await expect(recorder.complete(started, { status: 'succeeded' })).rejects.toThrow(/Evidence/);
  });

  it('rejects a succeeded receipt when no host Evidence verifier is configured', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const started = await recorder.start(lease);

    await expect(recorder.complete(started, {
      status: 'succeeded',
      evidenceIds: ['evidence-1'],
    })).rejects.toThrow(/Evidence verifier/);
  });

  it('verifies persisted host Evidence against the Worker assignment before success', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const evidence = {
      id: 'evidence-1',
      orchestrationId: 'orch-1',
      stageId: 'stage-1',
      kind: 'test' as const,
      status: 'passed' as const,
      summary: 'host test passed',
      capturedBy: 'host' as const,
      runId: lease.runId,
      taskId: lease.task.id,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
      worktreePath: lease.assignment.path,
      baseRevision: lease.assignment.baseRevision,
      createdAt: '2026-09-01T00:01:00.000Z',
    };
    const recorder = createWorkerSideEffectRecorder(
      repository,
      () => '2026-09-01T00:02:00.000Z',
      createWorkerEvidenceVerifier({ loadPersisted: async () => [evidence] }),
    );
    const started = await recorder.start(lease);

    await expect(recorder.complete(started, succeeded)).resolves.toMatchObject({
      status: 'receipt',
      receipt: { outcome: 'succeeded', evidenceIds: ['evidence-1'] },
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

  it('classifies interrupted recovery cancellation as AbortError', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const controller = new AbortController();
    controller.abort();

    await expect(recorder.recoverInterruptedRun('run-1', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('prevalidates the recovery journal before changing any started effect', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const started = await recorder.start(lease);
    await repository.record(startSideEffect(createSideEffect({
      idempotencyKey: 'cleanup:foreign-in-recovery',
      kind: 'worktree-cleanup',
      target: 'worktree-foreign',
      inputHash: 'cleanup-input',
      runId: 'run-1',
      taskId: 'task-foreign',
    })));

    await expect(recorder.recoverInterruptedRun('run-1')).rejects.toThrow(/worker-execution/);
    expect((await repository.read()).journal.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({
        idempotencyKey: started.idempotencyKey,
        status: 'started',
      })]),
    );
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

  it('rejects non-worker started effects from the worker recovery plan', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const effect = {
      idempotencyKey: 'worktree-cleanup:task-1:attempt-1',
      kind: 'worktree-cleanup',
      target: 'worktree-1',
      inputHash: 'cleanup-input',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
      status: 'started' as const,
      recovery: 'retry' as const,
    };

    expect(() => buildWorkerRunRecoveryPlan('run-1', { schemaVersion: 1, entries: [effect] })).toThrow(/worker-execution/);
  });

  it('rejects a worker effect whose taskExecutionId belongs to another run', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    const foreignExecutionId = createTaskExecutionId('foreign-run', 'task-1');
    const foreignAttemptId = createAttemptId(foreignExecutionId, 1);
    await repository.record({
      idempotencyKey: `worker-execution:${foreignAttemptId}`,
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: JSON.stringify(['run-1', 'task-1', 1, 1, 'base-1', 'C:/worktrees/task-1', 'worker/run-1/task-1/a1']),
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: foreignExecutionId,
      attemptId: foreignAttemptId,
      status: 'started',
      recovery: 'retry',
    });

    await expect(recorder.recoverInterruptedRun('run-1')).rejects.toThrow(/lineage/);
  });

  it('rejects a started worker effect that already carries a receipt', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const recorder = createWorkerSideEffectRecorder(repository);
    await repository.record({
      idempotencyKey: `worker-execution:${lease.attemptId}`,
      kind: 'worker-execution',
      target: lease.assignment.worktreeId,
      inputHash: JSON.stringify([
        lease.runId,
        lease.task.id,
        lease.task.version,
        lease.attempt,
        lease.assignment.baseRevision,
        lease.assignment.path,
        lease.assignment.branch,
      ]),
      runId: lease.runId,
      taskId: lease.task.id,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
      status: 'started',
      recovery: 'retry',
      receipt: {
        receiptId: 'late-receipt',
        observedAt: '2026-09-01T00:01:00.000Z',
        outcome: 'failed',
      },
    });

    await expect(recorder.recoverInterruptedRun('run-1')).rejects.toThrow(/状态不一致/);
  });

  it('rejects a legacy worker recovery record without assignment-bound path and branch', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const effect = {
      idempotencyKey: 'worker-execution:run-1:task-1:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'run-1:task-1:1:1:base-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
      status: 'started' as const,
      recovery: 'retry' as const,
    };

    expect(() => buildWorkerRunRecoveryPlan('run-1', { schemaVersion: 1, entries: [effect] })).toThrow(/path.*branch/);
  });

  it('rejects a recovery decision when any recoverable effect is stale for the current queue assignment', () => {
    const taskTwo = { ...lease.task, id: 'task-2', title: '第二任务' };
    const taskTwoExecutionId = createTaskExecutionId('run-1', 'task-2');
    const taskTwoAttemptId = createAttemptId(taskTwoExecutionId, 1);
    const valid = {
      idempotencyKey: `worker-execution:${lease.attemptId}`,
      kind: 'worker-execution',
      target: lease.assignment.worktreeId,
      inputHash: JSON.stringify([
        lease.runId,
        lease.task.id,
        lease.task.version,
        lease.attempt,
        lease.assignment.baseRevision,
        lease.assignment.path,
        lease.assignment.branch,
      ]),
      runId: lease.runId,
      taskId: lease.task.id,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
      status: 'unknown' as const,
      recovery: 'needs-user' as const,
    };
    const stale = {
      idempotencyKey: `worker-execution:${taskTwoAttemptId}`,
      kind: 'worker-execution',
      target: 'worktree-2',
      inputHash: JSON.stringify(['run-1', 'task-2', 1, 1, 'base-2', 'C:/worktrees/task-2', 'worker/run-1/task-2/a1']),
      runId: 'run-1',
      taskId: 'task-2',
      taskExecutionId: taskTwoExecutionId,
      attemptId: taskTwoAttemptId,
      status: 'unknown' as const,
      recovery: 'needs-user' as const,
    };
    const plan = buildWorkerRunRecoveryPlan('run-1', { schemaVersion: 1, entries: [valid, stale] });
    const state = {
      version: 1 as const,
      projectId: 'project-1',
      runId: 'run-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'running' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          taskExecutionId: lease.taskExecutionId,
          taskDefinitionVersion: 1 as const,
          status: 'running' as const,
          attempt: 1,
          currentAttemptId: lease.attemptId,
          worktreeId: lease.assignment.worktreeId,
          worktreePath: lease.assignment.path,
          branch: lease.assignment.branch,
          baseRevision: lease.assignment.baseRevision,
          evidenceIds: [],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
        'task-2': {
          taskId: 'task-2',
          taskExecutionId: taskTwoExecutionId,
          taskDefinitionVersion: 1 as const,
          status: 'queued' as const,
          attempt: 0,
          evidenceIds: [],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    };
    const taskGraph: ProjectTaskGraph = {
      version: 1,
      id: 'graph-1',
      sessionId: 'session-1',
      architectureId: 'architecture-1',
      graphVersion: 1,
      tasks: [lease.task, taskTwo],
      approval: 'approved',
      approvedBy: 'user',
      approvedAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(() => applyWorkerRunRecoveryDecision({
      plan,
      state,
      taskGraph,
      decision: 'retry',
      reason: '全部旧 effect 都需要重新核对',
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/当前|绑定|恢复/);
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
          taskDefinitionVersion: 1 as const,
          status: 'running' as const,
          attempt: 1,
          currentAttemptId: lease.attemptId,
          worktreeId: 'worktree-1',
          worktreePath: 'C:/worktrees/task-1',
          branch: lease.assignment.branch,
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
    })).toThrow(/没有绑定可处理的任务|当前 task\/attempt\/assignment/);

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
    })).toThrow(/没有绑定可处理的任务|当前 task\/attempt\/assignment/);

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
