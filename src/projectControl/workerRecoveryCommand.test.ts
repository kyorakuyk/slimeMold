import { describe, expect, it } from 'vitest';
import type { SideEffectJournal } from '../domain/sideEffects';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { ProjectTaskGraph } from './types';
import { recoverWorkerRunCommand } from './workerRecoveryCommand';
import { applyWorkerRunRecoveryDecision, buildWorkerRunRecoveryPlan } from './workerSideEffects';

const graph: ProjectTaskGraph = {
  version: 1,
  id: 'graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 1,
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
  }, {
    version: 1,
    id: 'task-2',
    architectureId: 'architecture-1',
    title: '依赖任务',
    description: '等待前置',
    moduleId: 'module-2',
    scope: ['src/feature-2.ts'],
    dependsOn: ['task-1'],
    acceptanceCriteria: ['测试通过'],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const state: WorkerRunQueueState = {
  version: 1,
  projectId: 'project-1',
  runId: 'run-1',
  orchestrationId: 'orch-1',
  taskGraphId: 'graph-1',
  taskGraphVersion: 1,
  status: 'running',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:01:00.000Z',
  tasks: {
    'task-1': {
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      status: 'running',
      attempt: 1,
      currentAttemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreeId: 'worktree-1',
      worktreePath: 'C:/worktrees/task-1',
      baseRevision: 'base-1',
      evidenceIds: [],
      acceptanceId: 'acceptance-old',
      updatedAt: '2026-09-01T00:01:00.000Z',
    },
    'task-2': {
      taskId: 'task-2',
      status: 'queued',
      attempt: 0,
      evidenceIds: [],
      updatedAt: '2026-09-01T00:01:00.000Z',
    },
  },
};

const unknownJournal: SideEffectJournal = {
  schemaVersion: 1,
  entries: [{
    idempotencyKey: 'worker-execution:run-1:task-1:attempt-1',
    kind: 'worker-execution',
    target: 'worktree-1',
    inputHash: 'input-1',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
    attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
    status: 'unknown',
    recovery: 'needs-user',
    unknownReason: 'worker-run-restarted',
  }],
};

describe('recoverWorkerRunCommand', () => {
  it('records an explicit retry decision and queues a new attempt without running it', () => {
    const result = recoverWorkerRunCommand({
      projectId: 'project-1',
      state,
      taskGraph: graph,
      journal: unknownJournal,
      decision: 'retry',
      reason: '确认旧执行没有产生可交付结果',
      decisionId: 'recovery-decision-1',
      now: '2026-09-01T00:04:00.000Z',
    });

    expect(result.state.status).toBe('queued');
    expect(result.state.tasks['task-1']).toMatchObject({ status: 'queued', attempt: 1 });
    expect(result.state.tasks['task-1'].currentAttemptId).toBeUndefined();
    expect(result.state.tasks['task-1'].acceptanceId).toBeUndefined();
    expect(result.events.map((event) => event.eventType)).toEqual([
      'WorkerRunRecoveryDecided',
      'RunQueued',
      'TaskQueued',
    ]);
    expect(result.events[0].payload).toMatchObject({ decision: 'retry', effectKeys: [unknownJournal.entries[0].idempotencyKey] });
    const queuedEvent = result.events.find((event) => event.eventType === 'TaskQueued');
    expect(queuedEvent).toMatchObject({
      aggregateType: 'TaskExecution',
      aggregateId: createTaskExecutionId('run-1', 'task-1'),
      payload: {
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
        nextAttempt: 2,
      },
    });
  });

  it('records skip as failed/blocked facts and leaves inspect as a non-mutating decision', () => {
    const skipped = recoverWorkerRunCommand({
      projectId: 'project-1',
      state,
      taskGraph: graph,
      journal: unknownJournal,
      decision: 'skip',
      reason: '保留当前结果，不重做副作用',
      decisionId: 'recovery-decision-2',
      now: '2026-09-01T00:04:00.000Z',
    });
    expect(skipped.state.status).toBe('partial');
    expect(skipped.state.tasks['task-1'].status).toBe('failed');
    expect(skipped.state.tasks['task-2'].status).toBe('blocked');
    expect(skipped.events.map((event) => event.eventType)).toEqual([
      'WorkerRunRecoveryDecided',
      'RunPartial',
      'TaskFailed',
      'TaskBlocked',
    ]);
    expect(skipped.events.find((event) => event.eventType === 'TaskFailed')).toMatchObject({
      aggregateType: 'TaskExecution',
      aggregateId: createTaskExecutionId('run-1', 'task-1'),
      payload: {
        taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
        attempt: 1,
        attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      },
    });
    expect(skipped.events.find((event) => event.eventType === 'TaskBlocked')).toMatchObject({
      aggregateType: 'TaskExecution',
      aggregateId: createTaskExecutionId('run-1', 'task-2'),
      payload: {
        taskExecutionId: createTaskExecutionId('run-1', 'task-2'),
      },
    });

    const inspected = recoverWorkerRunCommand({
      projectId: 'project-1',
      state,
      taskGraph: graph,
      journal: unknownJournal,
      decision: 'inspect',
      reason: '先检查 worktree',
      decisionId: 'recovery-decision-3',
      now: '2026-09-01T00:04:00.000Z',
    });
    expect(inspected.state).toEqual(state);
    expect(inspected.events.map((event) => event.eventType)).toEqual(['WorkerRunRecoveryDecided']);
  });

  it('rejects partial, unscoped, and queued-stale recovery effects', () => {
    expect(() => recoverWorkerRunCommand({
      projectId: 'project-2',
      state,
      taskGraph: graph,
      journal: unknownJournal,
      decision: 'retry',
      reason: '错误项目',
      decisionId: 'recovery-wrong-project',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/不属于当前项目/);
    expect(() => recoverWorkerRunCommand({
      projectId: 'project-1',
      state,
      taskGraph: graph,
      journal: { schemaVersion: 1, entries: [] },
      decision: 'retry',
      reason: '没有 effect',
      decisionId: 'recovery-no-effect',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/待核对的副作用/);

    const partial = {
      ...unknownJournal.entries[0],
      attemptId: undefined,
    };
    const unscoped = {
      ...unknownJournal.entries[0],
      taskId: undefined,
      taskExecutionId: undefined,
      attemptId: undefined,
    };
    for (const journal of [
      { schemaVersion: 1 as const, entries: [partial] },
      { schemaVersion: 1 as const, entries: [unscoped] },
    ]) {
      expect(() => recoverWorkerRunCommand({
        projectId: 'project-1',
        state,
        taskGraph: graph,
        journal,
        decision: 'retry',
        reason: '不完整的副作用归属',
        decisionId: 'recovery-invalid-lineage',
        now: '2026-09-01T00:04:00.000Z',
      })).toThrow(/没有绑定|lineage|归属/);
    }

    expect(() => recoverWorkerRunCommand({
      projectId: 'project-1',
      state: {
        ...state,
        tasks: {
          ...state.tasks,
          'task-1': {
            ...state.tasks['task-1'],
            status: 'queued',
            currentAttemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 2),
          },
        },
      },
      taskGraph: graph,
      journal: unknownJournal,
      decision: 'retry',
      reason: 'queued task 不得使用旧 attempt',
      decisionId: 'recovery-queued-stale',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/没有绑定|当前 Attempt|queued/);
  });

  it('rejects a recovery plan with a foreign run or trusted legacy metadata', () => {
    const validPlan = buildWorkerRunRecoveryPlan('run-1', unknownJournal);
    expect(() => applyWorkerRunRecoveryDecision({
      plan: { ...validPlan, runId: 'run-foreign' },
      state,
      taskGraph: graph,
      decision: 'retry',
      reason: 'foreign plan',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/run|Run|一致/);

    const receiptOnly = {
      ...unknownJournal.entries[0],
      status: 'receipt' as const,
      recovery: 'skip' as const,
      receipt: { receiptId: 'receipt-1', observedAt: '2026-09-01T00:02:00.000Z', outcome: 'succeeded' as const },
    };
    expect(() => applyWorkerRunRecoveryDecision({
      plan: {
        runId: 'run-1',
        effects: [receiptOnly],
        effectKeys: [unknownJournal.entries[0].idempotencyKey],
        requiresUser: true,
        allowedDecisions: ['inspect', 'retry', 'skip'],
      },
      state,
      taskGraph: graph,
      decision: 'retry',
      reason: 'receipt must not be trusted as recoverable',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/待核对|绑定|recover/);

    const extra = { ...unknownJournal.entries[0], idempotencyKey: 'worker-effect-2' };
    expect(() => applyWorkerRunRecoveryDecision({
      plan: {
        ...validPlan,
        effects: [...validPlan.effects, extra],
        recoverableEffects: [validPlan.effects[0]],
      },
      state,
      taskGraph: graph,
      decision: 'retry',
      reason: 'subset must not hide an effect',
      now: '2026-09-01T00:04:00.000Z',
    })).toThrow(/recoverable|完整|全部|plan/);
  });
});
