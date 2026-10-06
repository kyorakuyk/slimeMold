import type { ProjectTask } from '../projectControl/types';
import type { WorktreeInfo } from './worktree';
import { pathComparisonKey } from './path-utils';
import type {
  WorkerWorktreeAllocator,
  WorkerWorktreeAssignment,
} from '../domain/workerQueue';
import {
  assertTaskExecutionLineage,
  createAttemptId,
  createTaskExecutionId,
  workerIdentitySegment,
  type AttemptId,
  type TaskExecutionId,
} from '../domain/execution';

export interface WorktreeCreator {
  create(
    id: string,
    path: string,
    options?: { branch?: string; signal?: AbortSignal },
  ): Promise<WorktreeInfo | null>;
  getLastCreateError?: () => string | null;
  cleanup?: (id: string, opts?: { confirm?: boolean; signal?: AbortSignal }) => Promise<boolean>;
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
    async allocate({ projectId, runId, task, attempt, taskExecutionId, attemptId, signal }): Promise<WorkerWorktreeAssignment> {
      if (signal?.aborted) throw new Error('Worker worktree 分配已取消');
      const executionId = taskExecutionId ?? createTaskExecutionId(runId, task.id);
      const executionAttemptId = attemptId ?? createAttemptId(executionId, attempt);
      assertTaskExecutionLineage({
        runId,
        taskId: task.id,
        taskExecutionId: executionId,
        attemptId: executionAttemptId,
        attempt,
      });
      const identitySegment = workerIdentitySegment(executionAttemptId);
      const worktreeId = `worker-${identitySegment}`;
      const path = requiredText(pathFor({ projectId, runId, task, attempt, taskExecutionId: executionId, attemptId: executionAttemptId }), 'worktree 路径');
      const pathKey = pathComparisonKey(path);
      const existingOwner = reservedPaths.get(pathKey);
      if (existingOwner) {
        throw new Error(`worktree 路径已被 Attempt ${existingOwner} 保留，拒绝复用：${path}`);
      }
      reservedPaths.set(pathKey, executionAttemptId);
      const branch = `worker/${identitySegment}`;
      let createReturned = false;
      let createdInfo: WorktreeInfo | null = null;
      try {
        const info = await creator.create(worktreeId, path, { branch, signal });
        createReturned = true;
        createdInfo = info;
        if (signal?.aborted) throw new Error('Worker worktree 分配已取消');
        if (!info || info.status !== 'created') {
          const detail = creator.getLastCreateError?.();
          throw new Error(`创建 worktree 失败：${worktreeId}${detail ? `（${detail}）` : ''}`);
        }
        if (
          info.id !== worktreeId
          || pathComparisonKey(info.path) !== pathKey
          || info.branch !== branch
        ) {
          throw new Error(`worktree creator 返回的身份与请求不一致：${worktreeId}`);
        }
        return {
          worktreeId: requiredText(info.id, 'worktree id'),
          path: requiredText(info.path, 'worktree 路径'),
          branch: requiredText(info.branch, 'worktree 分支'),
          baseRevision: requiredText(info.baseRevision, 'worktree 基线'),
          ...(info.branchRevision ? { branchRevision: requiredText(info.branchRevision, 'worktree 分支 revision') } : {}),
          ...(info.targetIdentity ? { targetIdentity: requiredText(info.targetIdentity, 'worktree target identity') } : {}),
        };
      } catch (error) {
        if (createdInfo?.status === 'created') {
          if (!creator.cleanup) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}；创建后的 worktree 无法回滚：宿主未提供 cleanup（${createdInfo.id}）`);
          }
          try {
            const cleaned = await creator.cleanup(createdInfo.id, { confirm: true });
            if (!cleaned) throw new Error(`worktree rollback 未确认完成：${createdInfo.id}`);
            reservedPaths.delete(pathKey);
          } catch (cleanupCause) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}；创建后的 worktree 回滚失败：${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}`);
          }
        } else if (createReturned) {
          // The creator returned no created worktree; the reservation is safe to release.
          reservedPaths.delete(pathKey);
        }
        // If create itself threw, keep the reservation: the host may have mutated
        // before reporting the error and the path must not be reused blindly.
        throw error;
      }
    },
    async release(assignment, signal): Promise<void> {
      if (!creator.cleanup) {
        throw new Error(`无法回滚已分配 worktree：宿主未提供 cleanup（${assignment.worktreeId}）`);
      }
      const cleaned = await creator.cleanup(assignment.worktreeId, { confirm: true, signal });
      if (!cleaned) throw new Error(`worktree rollback 未确认完成：${assignment.worktreeId}`);
      reservedPaths.delete(pathComparisonKey(assignment.path));
    },
  };
}
