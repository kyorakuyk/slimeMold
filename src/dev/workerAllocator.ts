import type { ProjectTask } from '../projectControl/types';
import type { WorktreeInfo } from './worktree';
import type {
  WorkerWorktreeAllocator,
  WorkerWorktreeAssignment,
} from '../domain/workerQueue';

export interface WorktreeCreator {
  create(
    id: string,
    path: string,
    options?: { branch?: string },
  ): Promise<WorktreeInfo | null>;
}

export type WorkerWorktreePathFactory = (input: {
  projectId: string;
  runId: string;
  task: ProjectTask;
  attempt: number;
}) => string;

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'item';
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

/**
 * Adapt the host WorktreeManager to the queue's lease interface.
 * The path is deliberately supplied by the host; this adapter never guesses a
 * repository path and never returns the main repository as a fallback.
 */
export function createWorktreeAllocator(
  creator: WorktreeCreator,
  pathFor: WorkerWorktreePathFactory,
): WorkerWorktreeAllocator {
  return {
    async allocate({ projectId, runId, task, attempt }): Promise<WorkerWorktreeAssignment> {
      const worktreeId = `worker-${safeSegment(runId)}-${safeSegment(task.id)}-a${attempt}`;
      const path = requiredText(pathFor({ projectId, runId, task, attempt }), 'worktree 路径');
      const branch = `worker/${safeSegment(runId)}/${safeSegment(task.id)}/a${attempt}`;
      const info = await creator.create(worktreeId, path, { branch });
      if (!info || info.status !== 'created') {
        throw new Error(`创建 worktree 失败：${worktreeId}`);
      }
      return {
        worktreeId: requiredText(info.id, 'worktree id'),
        path: requiredText(info.path, 'worktree 路径'),
        branch: requiredText(info.branch, 'worktree 分支'),
        baseRevision: requiredText(info.baseRevision, 'worktree 基线'),
      };
    },
  };
}
