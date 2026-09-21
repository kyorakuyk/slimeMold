import { describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../store/workflowStoreTypes';
import { createAppWorkerRuntime } from './workerRuntime';

function createRuntime(addLog = vi.fn()) {
  return createAppWorkerRuntime({
    store: { getState: () => ({ addLog } as unknown as WorkflowState) },
    isTauri: false,
    recoverySingleFlight: { acquire: () => null },
    getProjectOperation: vi.fn(),
    assertProjectOperation: vi.fn(),
  });
}

describe('app Worker runtime composition', () => {
  it('exposes the project lifecycle and worker action ports', () => {
    const runtime = createRuntime();

    expect(runtime).toEqual(expect.objectContaining({
      recoverInterruptedWorkerEffects: expect.any(Function),
      loadProjectWorkerEvidence: expect.any(Function),
      restoreWorkerWorktrees: expect.any(Function),
      auditLoadedWorkerRunFacts: expect.any(Function),
      refreshWorkerCleanupProposals: expect.any(Function),
      runQueuedWorker: expect.any(Function),
      recoverWorkerRun: expect.any(Function),
      cleanupWorkerRun: expect.any(Function),
    }));
  });

  it('keeps worktree restore warnings in the application store port', async () => {
    const addLog = vi.fn();
    const runtime = createRuntime(addLog);
    const restore = vi.fn(async () => false);

    await runtime.restoreWorkerWorktrees(
      { manager: { restore } } as never,
      [{
        tasks: {
          task1: {
          taskId: 'task1',
          worktreeId: 'wt-task1',
          worktreePath: 'C:/workers/task1',
          branch: 'worker/task1',
          baseRevision: 'base-1',
          updatedAt: '2026-09-01T00:00:02.000Z',
          },
        },
      }] as never,
    );

    expect(restore).toHaveBeenCalledOnce();
    expect(addLog).toHaveBeenCalledWith('warn', expect.stringContaining('task1'));
  });
});
