import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import type { WorkerCleanupProposalReady } from './workerCleanup';
import { workerCleanupEffectKey } from './workerCleanup';
import { executeWorkerCleanupWithReceipt } from './workerCleanupExecution';
import type { SideEffectRecord } from '../domain/contracts';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

function proposal(): WorkerCleanupProposalReady {
  return {
    status: 'ready',
    runId: 'run-1',
    taskId: 'task-1',
    attempt: 1,
    taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
    attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
    worktreeId: 'wt-1',
    branch: 'worker/task-1',
    branchRevision: 'a'.repeat(40),
    branchRevisionRequired: true,
    worktreePath: 'C:/project-workers/run-1/task-1',
    baseRevision: 'abc123',
    stateSignature: 'sig-1',
    acceptanceId: 'acc-1',
    orchestrationId: 'orch-1',
    stageId: 'task-1',
    taskStatus: 'succeeded',
    cleanupStatus: 'active',
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
    expect(result.sideEffect.receipt?.receiptId).toBe(`${workerCleanupEffectKey(proposal().taskExecutionId, proposal().attemptId)}:receipt`);
    expect(confirmAndCleanup).toHaveBeenCalledWith(
      proposal().worktreePath,
      undefined,
      expect.any(String),
    );
    await expect(repository.read()).resolves.toMatchObject({
      status: 'ok',
      journal: { entries: [expect.objectContaining({ status: 'receipt' })] },
    });
  });

  it('finalizes a cleanup receipt when cancellation arrives after the host gate cleans', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const controller = new AbortController();
    const confirmAndCleanup = vi.fn(async () => {
      controller.abort();
      return true;
    });

    const result = await executeWorkerCleanupWithReceipt({
      proposal: proposal(),
      repository,
      host: { confirmAndCleanup },
      now: '2026-09-01T00:03:00.000Z',
      signal: controller.signal,
    });

    expect(result.cleaned).toBe(true);
    expect(result.sideEffect.status).toBe('receipt');
    expect(result.sideEffect.receipt?.outcome).toBe('succeeded');
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

  it('rejects an existing receipt whose lineage does not match the current proposal', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const current = proposal();
    const wrongExecutionId = createTaskExecutionId('run-other', 'task-1');
    const wrongReceipt: SideEffectRecord = {
      idempotencyKey: workerCleanupEffectKey(current.taskExecutionId, current.attemptId),
      kind: 'worktree-cleanup',
      target: current.worktreePath,
      inputHash: `${current.baseRevision}:${current.stateSignature}`,
      runId: current.runId,
      taskId: current.taskId,
      taskExecutionId: wrongExecutionId,
      attemptId: createAttemptId(wrongExecutionId, 1),
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: 'wrong-receipt',
        observedAt: '2026-09-01T00:03:00.000Z',
        outcome: 'succeeded',
        outputHash: current.stateSignature,
      },
    };
    await repository.record(wrongReceipt);

    await expect(executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true) },
      now: '2026-09-01T00:04:00.000Z',
    })).rejects.toThrow(/lineage|receipt/);
  });

  it('rejects an existing cleanup receipt with failed outcome', async () => {
    const current = proposal();
    const key = workerCleanupEffectKey(current.taskExecutionId, current.attemptId);
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    await repository.record({
      idempotencyKey: key,
      kind: 'worktree-cleanup',
      target: current.worktreePath,
      inputHash: `${current.baseRevision}:${current.stateSignature}`,
      runId: current.runId,
      taskId: current.taskId,
      taskExecutionId: current.taskExecutionId,
      attemptId: current.attemptId,
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: `${key}:receipt`,
        observedAt: '2026-09-01T00:02:00.000Z',
        outcome: 'failed',
        outputHash: current.stateSignature,
      },
    });

    await expect(executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true) },
      now: '2026-09-01T00:03:00.000Z',
    })).rejects.toThrow(/failed|失败|outcome/);
  });

  it('rejects an existing cleanup receipt whose receipt id is not bound to its key', async () => {
    const current = proposal();
    const key = workerCleanupEffectKey(current.taskExecutionId, current.attemptId);
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    await repository.record({
      idempotencyKey: key,
      kind: 'worktree-cleanup',
      target: current.worktreePath,
      inputHash: `${current.baseRevision}:${current.stateSignature}`,
      runId: current.runId,
      taskId: current.taskId,
      taskExecutionId: current.taskExecutionId,
      attemptId: current.attemptId,
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: 'wrong-receipt',
        observedAt: '2026-09-01T00:01:00.000Z',
        outcome: 'succeeded',
        outputHash: current.stateSignature,
      },
    });

    await expect(executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true) },
      now: '2026-09-01T00:02:00.000Z',
    })).rejects.toThrow(/receipt/);
  });

  it('migrates a matching legacy cleanup receipt to the canonical attempt key', async () => {
    const current = proposal();
    const legacyKey = `cleanup:${current.runId}:${current.taskId}:a${current.attempt}`;
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    await repository.record({
      idempotencyKey: legacyKey,
      kind: 'worktree-cleanup',
      target: current.worktreePath,
      inputHash: `${current.baseRevision}:${current.stateSignature}`,
      runId: current.runId,
      taskId: current.taskId,
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: `${legacyKey}:receipt`,
        observedAt: '2026-09-01T00:02:00.000Z',
        outcome: 'succeeded',
        outputHash: current.stateSignature,
      },
    });

    const result = await executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true) },
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.cleaned).toBe(true);
    expect(result.sideEffect.idempotencyKey).toBe(workerCleanupEffectKey(current.taskExecutionId, current.attemptId));
    expect(result.sideEffect.receipt?.receiptId).toBe(`${workerCleanupEffectKey(current.taskExecutionId, current.attemptId)}:receipt`);
    expect((await repository.read()).journal.entries).toEqual([
      expect.objectContaining({ idempotencyKey: workerCleanupEffectKey(current.taskExecutionId, current.attemptId) }),
    ]);
  });
});
