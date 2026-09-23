import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import {
  cleanupUnknownRunIds,
  reconcileSuccessfulCleanupReceipts,
} from './workerRecoveryFacts';

function effect(patch: Partial<SideEffectRecord>): SideEffectRecord {
  return {
    idempotencyKey: 'cleanup:attempt-1',
    kind: 'worktree-cleanup',
    target: 'C:/workers/task-1',
    inputHash: 'base-1:signature-1',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId: 'execution-1',
    attemptId: 'attempt-1',
    status: 'unknown',
    recovery: 'needs-user',
    ...patch,
  };
}

const run: WorkerRunQueueState = {
  version: 1,
  projectId: 'project-1',
  runId: 'run-1',
  orchestrationId: 'orchestration-1',
  taskGraphId: 'graph-1',
  taskGraphVersion: 1,
  status: 'failed',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  tasks: {},
};

const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
const attemptId = createAttemptId(taskExecutionId, 1);
const cleanupRun: WorkerRunQueueState = {
  ...run,
  tasks: {
    'task-1': {
      taskId: 'task-1',
      taskExecutionId,
      currentAttemptId: attemptId,
      status: 'succeeded',
      attempt: 1,
      worktreeId: 'wt-1',
      worktreePath: 'C:/workers/task-1',
      targetIdentity: 'v1:target-1',
      branch: 'worker/task-1',
      branchRevision: 'a'.repeat(40),
      baseRevision: 'abc123',
      worktreeStatus: 'created',
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
      updatedAt: run.updatedAt,
    },
  },
};

function successfulCleanupEffect(idempotencyKey: string, includeCleanup = true): SideEffectRecord {
  return effect({
    idempotencyKey,
    target: 'C:/workers/task-1',
    inputHash: 'abc123:sig-1',
    taskExecutionId,
    attemptId,
    status: 'receipt',
    recovery: 'skip',
    receipt: {
      receiptId: `${idempotencyKey}:receipt`,
      observedAt: '2026-09-01T00:01:00.000Z',
      outputHash: 'sig-1',
      outcome: 'succeeded',
      ...(includeCleanup ? {
        cleanup: {
          worktreePath: cleanupRun.tasks['task-1'].worktreePath!,
          worktreeId: cleanupRun.tasks['task-1'].worktreeId!,
          targetIdentity: cleanupRun.tasks['task-1'].targetIdentity,
          branch: cleanupRun.tasks['task-1'].branch!,
          branchRevision: cleanupRun.tasks['task-1'].branchRevision!,
          baseRevision: cleanupRun.tasks['task-1'].baseRevision!,
          finalStatus: 'absent' as const,
          hostVerifiedAt: '2026-09-01T00:01:00.000Z',
          hostReadback: {
            authority: 'native' as const,
            worktreePath: cleanupRun.tasks['task-1'].worktreePath!,
            branch: cleanupRun.tasks['task-1'].branch!,
            branchRevision: cleanupRun.tasks['task-1'].branchRevision!,
            targetIdentity: cleanupRun.tasks['task-1'].targetIdentity,
            finalStatus: 'absent' as const,
          },
        },
      } : {}),
    },
  });
}

describe('worker recovery facts', () => {
  it('collects only cleanup effects that require user recovery', () => {
    const ids = cleanupUnknownRunIds([
      effect({}),
      effect({ runId: 'run-2', status: 'receipt', recovery: 'skip' }),
      effect({ runId: undefined, status: 'unknown', recovery: 'needs-user' }),
    ]);

    expect([...ids]).toEqual(['run-1']);
  });

  it('does not mutate a run without a trusted successful cleanup receipt', () => {
    const result = reconcileSuccessfulCleanupReceipts([run], [effect({})]);

    expect(result.runs).toEqual([run]);
    expect(result.events).toEqual([]);
  });

  it('reconciles a canonical successful cleanup receipt into TaskCleaned', () => {
    const result = reconcileSuccessfulCleanupReceipts(
      [cleanupRun],
      [successfulCleanupEffect(`cleanup:${attemptId}`)],
    );

    expect(result.runs[0].tasks['task-1']).toMatchObject({
      cleanupStatus: 'cleaned',
      worktreeStatus: 'cleaned',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('TaskCleaned');
    expect(result.migrations).toEqual([]);
  });

  it('reconciles a legacy successful receipt using its canonical lineage', () => {
    const legacyKey = 'cleanup:run-1:task-1:a1';
    const result = reconcileSuccessfulCleanupReceipts(
      [cleanupRun],
      [successfulCleanupEffect(legacyKey)],
    );

    expect(result.runs[0].tasks['task-1'].cleanupStatus).toBe('cleaned');
    expect(result.events[0].payload).toMatchObject({ receiptId: `cleanup:${attemptId}:receipt` });
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0].legacyKey).toBe(legacyKey);
    expect(result.migrations[0].replacement.idempotencyKey).toBe(`cleanup:${attemptId}`);
  });

  it('marks an old successful receipt without cleanup facts for manual repair', () => {
    const legacyKey = 'cleanup:run-1:task-1:a1';
    const effects = [successfulCleanupEffect(legacyKey, false)];

    expect(reconcileSuccessfulCleanupReceipts([cleanupRun], effects).events).toEqual([]);
    expect([...cleanupUnknownRunIds(effects)]).toEqual(['run-1']);
  });

  it('fails closed on a canonical/legacy cleanup receipt collision', () => {
    const legacyKey = 'cleanup:run-1:task-1:a1';
    const effects = [
      successfulCleanupEffect(`cleanup:${attemptId}`),
      successfulCleanupEffect(legacyKey),
    ];

    expect(reconcileSuccessfulCleanupReceipts([cleanupRun], effects).events).toEqual([]);
    expect([...cleanupUnknownRunIds(effects)]).toEqual(['run-1']);
  });
});
