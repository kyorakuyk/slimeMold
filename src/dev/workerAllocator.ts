import type { ProjectTask } from '../projectControl/types';
import type { WorktreeInfo } from './worktree';
import { normalizeAbsolutePath } from './path-utils';
import type {
  WorkerWorktreeAllocator,
  WorkerWorktreeAssignment,
} from '../domain/workerQueue';
import { assertTaskExecutionLineage, createAttemptId, createTaskExecutionId, type AttemptId, type TaskExecutionId } from '../domain/execution';

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
  taskExecutionId?: TaskExecutionId;
  attemptId?: AttemptId;
}) => string;

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
  const reservedPaths = new Map<string, string>();
  return {
    async allocate({ projectId, runId, task, attempt, taskExecutionId, attemptId }): Promise<WorkerWorktreeAssignment> {
      const executionId = taskExecutionId ?? createTaskExecutionId(runId, task.id);
      const executionAttemptId = attemptId ?? createAttemptId(executionId, attempt);
      assertTaskExecutionLineage({
        runId,
        taskId: task.id,
        taskExecutionId: executionId,
        attemptId: executionAttemptId,
        attempt,
      });
      const identitySegment = encodeURIComponent(executionAttemptId);
      const worktreeId = `worker-${identitySegment}`;
      const path = requiredText(pathFor({ projectId, runId, task, attempt, taskExecutionId: executionId, attemptId: executionAttemptId }), 'worktree 路径');
      const pathKey = normalizeAbsolutePath(path);
      const existingOwner = reservedPaths.get(pathKey);
      if (existingOwner) {
        throw new Error(`worktree 路径已被 Attempt ${existingOwner} 保留，拒绝复用：${path}`);
      }
      reservedPaths.set(pathKey, executionAttemptId);
      const branch = `worker/${identitySegment}`;
      const info = await creator.create(worktreeId, path, { branch });
      if (!info || info.status !== 'created') {
        throw new Error(`创建 worktree 失败：${worktreeId}`);
      }
      if (
        info.id !== worktreeId
        || normalizeAbsolutePath(info.path) !== pathKey
        || info.branch !== branch
      ) {
        throw new Error(`worktree creator 返回的身份与请求不一致：${worktreeId}`);
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
