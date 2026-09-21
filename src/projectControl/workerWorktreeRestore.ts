import type { WorkerRunQueueState } from '../domain/workerQueue';

export interface WorkerWorktreeRestoreInfo {
  id: string;
  path: string;
  branch: string;
  baseRevision: string;
  branchRevision?: string;
  createdAt: string;
  status: 'created' | 'cleaned' | 'orphaned' | 'registration-pending';
}

export interface WorkerWorktreeRestoreManager {
  restore(
    info: WorkerWorktreeRestoreInfo,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
}

export interface WorkerWorktreeRestoreSession {
  manager: WorkerWorktreeRestoreManager;
}

export interface RestoreWorkerWorktreesInput {
  session: WorkerWorktreeRestoreSession;
  runs: readonly WorkerRunQueueState[];
  signal?: AbortSignal;
  warn: (message: string) => void;
}

/** Re-register durable Worker worktrees without taking ownership of persistence or UI state. */
export async function restoreWorkerWorktrees(
  input: RestoreWorkerWorktreesInput,
): Promise<void> {
  for (const run of input.runs) {
    for (const task of Object.values(run.tasks)) {
      if (input.signal?.aborted) return;
      if (task.cleanupStatus === 'cleaned') continue;
      if (!task.worktreeId || !task.worktreePath || !task.branch || !task.baseRevision) continue;

      const restored = await input.session.manager.restore({
        id: task.worktreeId,
        path: task.worktreePath,
        branch: task.branch,
        baseRevision: task.baseRevision,
        branchRevision: task.branchRevision,
        createdAt: task.updatedAt,
        status: task.worktreeStatus ?? 'created',
      }, { signal: input.signal });
      if (input.signal?.aborted) return;
      if (!restored) {
        input.warn(`Worker worktree 未能从 git 恢复登记：${task.taskId}`);
      }
    }
  }
}
