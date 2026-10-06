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
    targetIdentity: 'v1:target-1',
    baseRevision: 'abc123',
    stateSignature: 'sig-1',
    acceptanceId: 'acc-1',
    orchestrationId: 'orch-1',
    stageId: 'task-1',
    taskStatus: 'succeeded',
    cleanupStatus: 'active',
  };
}

const absentReadback = async (
  worktreePath = proposal().worktreePath,
  _worktreeId?: string,
  targetIdentity?: string,
) => ({
  present: false as const,
  status: 'absent' as const,
  hostReadback: {
    authority: 'native' as const,
    worktreePath,
    branch: proposal().branch,
    branchRevision: proposal().branchRevision,
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    finalStatus: 'absent' as const,
  },
});

describe('worker cleanup execution', () => {
  it('writes a start record, calls the approved host gate, and writes a receipt', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const confirmAndCleanup = vi.fn(async () => true);

    const result = await executeWorkerCleanupWithReceipt({
      proposal: proposal(),
      repository,
      host: { confirmAndCleanup, readCleanupState: absentReadback },
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

  it('binds the cleanup receipt to authoritative native host read-back facts', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const current = { ...proposal(), targetIdentity: 'v1:target-1' };
    const result = await executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: {
        confirmAndCleanup: vi.fn(async () => true),
        readCleanupState: async () => ({
          present: false as const,
          status: 'absent' as const,
          hostReadback: {
            authority: 'native' as const,
            worktreePath: current.worktreePath,
            branch: current.branch,
            branchRevision: current.branchRevision,
            targetIdentity: current.targetIdentity,
            finalStatus: 'absent' as const,
          },
        }),
      },
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.cleaned).toBe(true);
    expect(result.sideEffect.receipt?.cleanup).toMatchObject({
      worktreePath: current.worktreePath,
      targetIdentity: current.targetIdentity,
      branchRevision: current.branchRevision,
      finalStatus: 'absent',
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
      host: { confirmAndCleanup, readCleanupState: absentReadback },
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
    const input = { proposal: proposal(), repository, host: { confirmAndCleanup, readCleanupState: absentReadback }, now: '2026-09-01T00:03:00.000Z' };

    await expect(executeWorkerCleanupWithReceipt(input)).resolves.toMatchObject({
      cleaned: false,
      sideEffect: { status: 'unknown', recovery: 'needs-user' },
    });
    await expect(executeWorkerCleanupWithReceipt(input)).rejects.toThrow(/需要人工核对/);
    expect(confirmAndCleanup).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the host reports cleanup success but read-back still finds the worktree', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const confirmAndCleanup = vi.fn(async () => true);
    const result = await executeWorkerCleanupWithReceipt({
      proposal: proposal(),
      repository,
      host: {
        confirmAndCleanup,
        readCleanupState: async () => ({ present: true as const, status: 'created' as const }),
      },
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.cleaned).toBe(false);
    expect(result.sideEffect).toMatchObject({ status: 'unknown', recovery: 'needs-user' });
    expect(result.sideEffect.receipt).toBeUndefined();
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
      host: { confirmAndCleanup: vi.fn(async () => true), readCleanupState: absentReadback },
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
      host: { confirmAndCleanup: vi.fn(async () => true), readCleanupState: absentReadback },
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
      host: { confirmAndCleanup: vi.fn(async () => true), readCleanupState: absentReadback },
      now: '2026-09-01T00:02:00.000Z',
    })).rejects.toThrow(/receipt/);
  });

  it('rejects an existing successful cleanup receipt without native host read-back', async () => {
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
        outcome: 'succeeded',
        outputHash: current.stateSignature,
        cleanup: {
          worktreePath: current.worktreePath,
          worktreeId: current.worktreeId,
          branch: current.branch,
          branchRevision: current.branchRevision,
          baseRevision: current.baseRevision,
          finalStatus: 'absent',
          hostVerifiedAt: '2026-09-01T00:02:00.000Z',
        },
      },
    });

    await expect(executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true), readCleanupState: absentReadback },
      now: '2026-09-01T00:03:00.000Z',
    })).rejects.toThrow(/read-back|核对|receipt/);
  });

  it('rejects an identity-less existing receipt before idempotent success or migration', async () => {
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
      taskExecutionId: current.taskExecutionId,
      attemptId: current.attemptId,
      status: 'receipt',
      recovery: 'skip',
      receipt: {
        receiptId: `${legacyKey}:receipt`,
        observedAt: '2026-09-01T00:02:00.000Z',
        outputHash: current.stateSignature,
        outcome: 'succeeded',
        cleanup: {
          worktreePath: current.worktreePath,
          worktreeId: current.worktreeId,
          branch: current.branch,
          branchRevision: current.branchRevision,
          baseRevision: current.baseRevision,
          finalStatus: 'absent',
          hostVerifiedAt: '2026-09-01T00:02:00.000Z',
          hostReadback: {
            authority: 'native',
            worktreePath: current.worktreePath,
            branch: current.branch,
            branchRevision: current.branchRevision,
            finalStatus: 'absent',
          },
        },
      },
    });

    const confirmAndCleanup = vi.fn(async () => true);
    const readCleanupState = vi.fn(async (
      worktreePath = current.worktreePath,
      worktreeId?: string,
      targetIdentity?: string,
    ) => absentReadback(worktreePath, worktreeId, targetIdentity));
    await expect(executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup, readCleanupState },
      now: '2026-09-01T00:03:00.000Z',
    })).rejects.toThrow(/identity|receipt|清理/);
    expect(confirmAndCleanup).not.toHaveBeenCalled();
    expect(readCleanupState).not.toHaveBeenCalled();
    await expect(repository.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ idempotencyKey: legacyKey, status: 'receipt' })] },
    });
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
        cleanup: {
          worktreePath: current.worktreePath,
          worktreeId: current.worktreeId,
          ...(current.targetIdentity ? { targetIdentity: current.targetIdentity } : {}),
          branch: current.branch,
          branchRevision: current.branchRevision,
          baseRevision: current.baseRevision,
          finalStatus: 'absent',
          hostVerifiedAt: '2026-09-01T00:02:00.000Z',
          hostReadback: {
            authority: 'native',
            worktreePath: current.worktreePath,
            branch: current.branch,
            branchRevision: current.branchRevision,
            ...(current.targetIdentity ? { targetIdentity: current.targetIdentity } : {}),
            finalStatus: 'absent',
          },
        },
      },
    });

    const result = await executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: { confirmAndCleanup: vi.fn(async () => true), readCleanupState: absentReadback },
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
