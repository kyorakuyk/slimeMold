import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import type { WorkerCleanupProposalReady } from './workerCleanup';
import { executeWorkerCleanupWithReceipt } from './workerCleanupExecution';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

function proposal(): WorkerCleanupProposalReady {
  return {
    status: 'ready',
    runId: 'run-1',
    taskId: 'task-1',
    attempt: 1,
    taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
    attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
    worktreePath: 'C:/project-workers/run-1/task-1',
    baseRevision: 'abc123',
    stateSignature: 'sig-1',
    acceptanceId: 'acc-1',
    orchestrationId: 'orch-1',
    stageId: 'task-1',
  };
}

describe('worker cleanup execution', () => {
  it('writes a start record, calls the approved host gate, and writes a receipt', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const confirmAndCleanup = vi.fn(async () => true);

    const result = await executeWorkerCleanupWithReceipt({
      proposal: proposal(),
      repository,
      host: { confirmAndCleanup },
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.cleaned).toBe(true);
    expect(result.sideEffect.status).toBe('receipt');
    expect(result.sideEffect).toMatchObject({
      taskExecutionId: proposal().taskExecutionId,
      attemptId: proposal().attemptId,
    });
    expect(result.sideEffect.receipt?.receiptId).toBe('cleanup:run-1:task-1:a1:receipt');
    expect(confirmAndCleanup).toHaveBeenCalledWith(proposal().worktreePath);
    await expect(repository.read()).resolves.toMatchObject({
      status: 'ok',
      journal: { entries: [expect.objectContaining({ status: 'receipt' })] },
    });
  });

  it('turns a rejected host cleanup into unknown and refuses an automatic second delete', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const confirmAndCleanup = vi.fn(async () => false);
    const input = { proposal: proposal(), repository, host: { confirmAndCleanup }, now: '2026-09-01T00:03:00.000Z' };

    await expect(executeWorkerCleanupWithReceipt(input)).resolves.toMatchObject({
      cleaned: false,
      sideEffect: { status: 'unknown', recovery: 'needs-user' },
    });
    await expect(executeWorkerCleanupWithReceipt(input)).rejects.toThrow(/需要人工核对/);
    expect(confirmAndCleanup).toHaveBeenCalledTimes(1);
  });
});
