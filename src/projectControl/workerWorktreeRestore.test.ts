import { describe, expect, it, vi } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { restoreWorkerWorktrees } from './workerWorktreeRestore';

function runWithTasks(tasks: Record<string, unknown>): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'running',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    tasks,
  } as unknown as WorkerRunQueueState;
}

describe('restoreWorkerWorktrees', () => {
  it('restores assigned live tasks, skips cleaned/incomplete tasks, and reports failed registration', async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const warn = vi.fn();
    const session = { manager: { restore } };
    const runs = [runWithTasks({
      live: {
        taskId: 'live',
        cleanupStatus: undefined,
        worktreeId: 'wt-live',
        worktreePath: 'D:/workers/live',
        branch: 'worker/live',
        baseRevision: 'base-live',
        branchRevision: 'tip-live',
        worktreeStatus: 'created',
        updatedAt: '2026-09-01T00:00:02.000Z',
      },
      failedRestore: {
        taskId: 'failed-restore',
        worktreeId: 'wt-failed',
        worktreePath: 'D:/workers/failed',
        branch: 'worker/failed',
        baseRevision: 'base-failed',
        updatedAt: '2026-09-01T00:00:03.000Z',
      },
      cleaned: {
        taskId: 'cleaned',
        cleanupStatus: 'cleaned',
        worktreeId: 'wt-cleaned',
        worktreePath: 'D:/workers/cleaned',
        branch: 'worker/cleaned',
        baseRevision: 'base-cleaned',
        updatedAt: '2026-09-01T00:00:04.000Z',
      },
      incomplete: {
        taskId: 'incomplete',
        worktreeId: 'wt-incomplete',
        worktreePath: 'D:/workers/incomplete',
        branch: 'worker/incomplete',
        updatedAt: '2026-09-01T00:00:05.000Z',
      },
    })];

    await restoreWorkerWorktrees({ session, runs, warn });

    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenNthCalledWith(1, {
      id: 'wt-live',
      path: 'D:/workers/live',
      branch: 'worker/live',
      baseRevision: 'base-live',
      branchRevision: 'tip-live',
      createdAt: '2026-09-01T00:00:02.000Z',
      status: 'created',
    }, { signal: undefined });
    expect(restore).toHaveBeenNthCalledWith(2, {
      id: 'wt-failed',
      path: 'D:/workers/failed',
      branch: 'worker/failed',
      baseRevision: 'base-failed',
      branchRevision: undefined,
      createdAt: '2026-09-01T00:00:03.000Z',
      status: 'created',
    }, { signal: undefined });
    expect(warn).toHaveBeenCalledWith('Worker worktree 未能从 git 恢复登记：failed-restore');
  });

  it('stops before restoring when the operation is already aborted', async () => {
    const restore = vi.fn().mockResolvedValue(true);
    const controller = new AbortController();
    controller.abort();

    await restoreWorkerWorktrees({
      session: { manager: { restore } },
      runs: [runWithTasks({
        live: {
          taskId: 'live',
          worktreeId: 'wt-live',
          worktreePath: 'D:/workers/live',
          branch: 'worker/live',
          baseRevision: 'base-live',
          updatedAt: '2026-09-01T00:00:02.000Z',
        },
      })],
      signal: controller.signal,
      warn: vi.fn(),
    });

    expect(restore).not.toHaveBeenCalled();
  });
});
