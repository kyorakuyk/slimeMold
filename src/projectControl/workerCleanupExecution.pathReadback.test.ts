import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { WorkerCleanupProposalReady } from './workerCleanup';
import { executeWorkerCleanupWithReceipt } from './workerCleanupExecution';

function proposal(): WorkerCleanupProposalReady & { targetIdentity: string } {
  const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
  return {
    status: 'ready',
    runId: 'run-1',
    taskId: 'task-1',
    attempt: 1,
    taskExecutionId,
    attemptId: createAttemptId(taskExecutionId, 1),
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

const absentReadback = (
  worktreePath: string,
  targetIdentity: string,
) => ({
  present: false as const,
  status: 'absent' as const,
  hostReadback: {
    authority: 'native' as const,
    worktreePath,
    branch: proposal().branch,
    branchRevision: proposal().branchRevision,
    targetIdentity,
    finalStatus: 'absent' as const,
  },
});

describe('worker cleanup native host read-back path comparison', () => {
  it('binds the cleanup receipt to authoritative native host read-back facts', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const current = proposal();
    const result = await executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: {
        confirmAndCleanup: vi.fn(async () => true),
        readCleanupState: async () => absentReadback(current.worktreePath, current.targetIdentity),
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

  it('accepts a native Windows verbatim path alias in cleanup read-back', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'C:/project');
    const current = proposal();
    const separator = String.fromCharCode(92);
    const nativePath = `${separator}${separator}?${separator}C:${separator}project-workers${separator}run-1${separator}task-1`;
    const result = await executeWorkerCleanupWithReceipt({
      proposal: current,
      repository,
      host: {
        confirmAndCleanup: vi.fn(async () => true),
        readCleanupState: async () => absentReadback(
          nativePath,
          current.targetIdentity,
        ),
      },
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.cleaned).toBe(true);
    expect(result.sideEffect.receipt?.cleanup?.hostReadback).toMatchObject({
      authority: 'native',
      worktreePath: nativePath,
      targetIdentity: current.targetIdentity,
      finalStatus: 'absent',
    });
  });
});
