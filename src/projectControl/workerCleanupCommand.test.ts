import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { markWorkerTaskCleaned } from './workerCleanupCommand';

function state(): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'succeeded',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'succeeded',
        attempt: 1,
        evidenceIds: ['ev-1'],
        acceptanceId: 'acc-1',
        worktreeId: 'wt-1',
        worktreePath: 'C:/project-workers/run-1/task-1',
        branch: 'worker/task-1',
        baseRevision: 'abc123',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
  };
}

function cleanupReceipt(attempt: number): SideEffectRecord {
  const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
  const attemptId = createAttemptId(taskExecutionId, attempt);
  return {
    idempotencyKey: `cleanup:${attemptId}`,
    kind: 'worktree-cleanup',
    target: 'C:/project-workers/run-1/task-1',
    inputHash: 'abc123:sig-1',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId,
    attemptId,
    status: 'receipt',
    recovery: 'skip',
    receipt: { receiptId: 'receipt-cleanup-1', observedAt: '2026-09-01T00:02:00.000Z' },
  };
}

describe('worker cleanup command', () => {
  it('marks a host-cleaned task and emits an auditable TaskCleaned event', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const result = markWorkerTaskCleaned({
      state: state(),
      taskId: 'task-1',
      receiptId: 'receipt-cleanup-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
      receipt: cleanupReceipt(1),
      decisionId: 'cleanup-decision-1',
      now: '2026-09-01T00:02:00.000Z',
    });

    expect(result.state.tasks['task-1']).toEqual(expect.objectContaining({
      cleanupStatus: 'cleaned',
      cleanupReceiptId: 'receipt-cleanup-1',
    }));
    expect(result.events).toEqual([expect.objectContaining({
      eventId: `cleanup-decision-1:task-cleaned:${taskExecutionId}`,
      eventType: 'TaskCleaned',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      payload: expect.objectContaining({
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId: createAttemptId(taskExecutionId, 1),
        receiptId: 'receipt-cleanup-1',
      }),
    })]);
  });

  it('rejects cleanup for a non-succeeded task or a missing receipt id', () => {
    expect(() => markWorkerTaskCleaned({
      state: { ...state(), tasks: { ...state().tasks, 'task-1': { ...state().tasks['task-1'], status: 'failed' } } },
      taskId: 'task-1',
      receiptId: 'receipt-cleanup-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      receipt: cleanupReceipt(1),
      decisionId: 'cleanup-decision-1',
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/只有 succeeded 任务才能标记清理完成/);
    expect(() => markWorkerTaskCleaned({
      state: state(),
      taskId: 'task-1',
      receiptId: ' ',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      receipt: cleanupReceipt(1),
      decisionId: 'cleanup-decision-1',
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/receipt id 不能为空/);
  });

  it('rejects a cleanup receipt that belongs to an older attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const currentAttemptId = createAttemptId(taskExecutionId, 2);
    const currentState = {
      ...state(),
      tasks: {
        'task-1': {
          ...state().tasks['task-1'],
          attempt: 2,
          taskExecutionId,
          currentAttemptId,
        },
      },
    };

    expect(() => markWorkerTaskCleaned({
      state: currentState,
      taskId: 'task-1',
      receiptId: 'receipt-cleanup-1',
      taskExecutionId,
      attemptId: currentAttemptId,
      receipt: cleanupReceipt(1),
      decisionId: 'cleanup-decision-2',
      now: '2026-09-01T00:03:00.000Z',
    })).toThrow(/lineage|attempt|receipt/);
  });
});
