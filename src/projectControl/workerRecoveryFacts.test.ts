import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
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
});
