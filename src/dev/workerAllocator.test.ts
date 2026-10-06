import { describe, expect, it, vi } from 'vitest';
import type { ProjectTask } from '../projectControl/types';
import { createAttemptId, createTaskExecutionId, workerIdentitySegment } from '../domain/execution';
import type { WorktreeInfo } from './worktree';
import { createWorktreeAllocator } from './workerAllocator';
import { WorkerAllocationRepairRequiredError } from '../domain/workerQueue';

const task: ProjectTask = {
  version: 1,
  id: 'task/one',
  architectureId: 'architecture-1',
  title: '实现任务',
  description: '完成实现',
  moduleId: 'module-1',
  scope: ['src'],
  dependsOn: [],
  acceptanceCriteria: ['测试通过'],
  category: 'implementation',
  status: 'approved',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function info(id: string, path: string, branch: string): WorktreeInfo {
  return {
    id,
    path,
    branch,
    baseRevision: 'base-1',
    createdAt: '2026-09-01T00:00:01.000Z',
    status: 'created',
  };
}

describe('createWorktreeAllocator', () => {
  it('creates one manager worktree per worker lease with Rust-compatible identity', async () => {
    const create = vi.fn(async (id: string, path: string, options?: { branch?: string }) =>
      info(id, path, options?.branch ?? ''));
    const allocator = createWorktreeAllocator(
      { create },
      ({ task: queuedTask, attempt }) => `C:/projects/worktrees/${queuedTask.id}/${attempt}`,
    );
    const taskExecutionId = createTaskExecutionId('run/one', 'task/one');
    const attemptId = createAttemptId(taskExecutionId, 2);
    const assignment = await allocator.allocate({
      projectId: 'project/one',
      runId: 'run/one',
      task,
      attempt: 2,
      taskExecutionId,
      attemptId,
    });

    expect(create).toHaveBeenCalledWith(
      expect.stringMatching(/^worker-w-[0-9a-f]+$/),
      'C:/projects/worktrees/task/one/2',
      { branch: expect.stringMatching(/^worker\/w-[0-9a-f]+$/) },
    );
    expect(assignment.branch).not.toContain('%');
    const identity = assignment.branch.slice('worker/'.length);
    expect(identity).toMatch(/^w-[0-9a-f]+$/);
    expect(identity.length).toBeLessThanOrEqual(200);
    expect(assignment).toEqual({
      worktreeId: `worker-${identity}`,
      path: 'C:/projects/worktrees/task/one/2',
      branch: `worker/${identity}`,
      baseRevision: 'base-1',
    });
  });

  it('rejects worktree creation failure instead of returning a main-repo fallback', async () => {
    const allocator = createWorktreeAllocator(
      { create: vi.fn(async () => null) },
      () => 'C:/projects/worktrees/task-one/1',
    );

    await expect(allocator.allocate({
      projectId: 'project-1',
      runId: 'run-1',
      task,
      attempt: 1,
      taskExecutionId: createTaskExecutionId('run-1', 'task/one'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task/one'), 1),
    })).rejects.toThrow(/创建 worktree 失败/);
  });

  it('releases a path reservation when creation fails so the attempt can retry', async () => {
    let calls = 0;
    const allocator = createWorktreeAllocator(
      { create: vi.fn(async (id: string, path: string, options?: { branch?: string }) => {
        calls += 1;
        return calls === 1 ? null : info(id, path, options?.branch ?? '');
      }) },
      () => 'C:/projects/worktrees/retryable',
    );
    const taskExecutionId = createTaskExecutionId('run-retry', task.id);
    const input = {
      projectId: 'project-1',
      runId: 'run-retry',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };

    await expect(allocator.allocate(input)).rejects.toThrow(/创建 worktree 失败/);
    await expect(allocator.allocate(input)).resolves.toMatchObject({ path: 'C:/projects/worktrees/retryable' });
  });

  it('rejects a lease whose supplied execution lineage is forged', async () => {
    const allocator = createWorktreeAllocator(
      { create: vi.fn(async (id: string, path: string, options?: { branch?: string }) => info(id, path, options?.branch ?? '')) },
      () => 'C:/projects/worktrees/task-one/1',
    );
    const forgedExecutionId = createTaskExecutionId('other-run', task.id);

    await expect(allocator.allocate({
      projectId: 'project-1',
      runId: 'run-1',
      task,
      attempt: 1,
      taskExecutionId: forgedExecutionId,
      attemptId: createAttemptId(forgedExecutionId, 1),
    })).rejects.toThrow(/lineage|execution|attempt/);
  });

  it('rejects a custom path factory that reuses one path for different attempts', async () => {
    const allocator = createWorktreeAllocator(
      { create: vi.fn(async (id: string, path: string, options?: { branch?: string }) => info(id, path, options?.branch ?? '')) },
      () => 'C:/projects/worktrees/shared',
    );
    const firstExecutionId = createTaskExecutionId('run-1', task.id);
    const secondExecutionId = createTaskExecutionId('run-2', task.id);

    await allocator.allocate({
      projectId: 'project-1', runId: 'run-1', task, attempt: 1,
      taskExecutionId: firstExecutionId, attemptId: createAttemptId(firstExecutionId, 1),
    });
    await expect(allocator.allocate({
      projectId: 'project-1', runId: 'run-2', task, attempt: 1,
      taskExecutionId: secondExecutionId, attemptId: createAttemptId(secondExecutionId, 1),
    })).rejects.toThrow(/路径|复用|worktree/);
  });

  it('requires repair instead of cleaning a host allocation with mismatched identity', async () => {
    const cleanup = vi.fn(async () => true);
    const create = vi.fn(async (id: string, path: string, options?: { branch?: string }) => ({
      ...info(id, path, options?.branch ?? ''),
      path: `${path}-replaced`,
    }));
    const allocator = createWorktreeAllocator(
      { create, cleanup },
      () => 'C:/projects/worktrees/created-then-invalid',
    );
    const taskExecutionId = createTaskExecutionId('run-1', task.id);
    const input = {
      projectId: 'project-1',
      runId: 'run-1',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };

    let failure: unknown;
    try {
      await allocator.allocate(input);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WorkerAllocationRepairRequiredError);
    expect((failure as WorkerAllocationRepairRequiredError).allocation).toMatchObject({
      taskId: task.id,
      taskExecutionId,
      assignment: { path: 'C:/projects/worktrees/created-then-invalid-replaced' },
      worktreeStatus: 'orphaned',
    });
    expect(cleanup).not.toHaveBeenCalled();
    await expect(allocator.allocate(input)).rejects.toThrow(/保留|复用|路径/);
  });

  it('keeps the reservation when rollback cannot confirm host cleanup', async () => {
    const cleanup = vi.fn(async () => false);
    const create = vi.fn(async (id: string, path: string, options?: { branch?: string }) =>
      info(id, path, options?.branch ?? ''));
    const allocator = createWorktreeAllocator(
      { create, cleanup },
      () => 'C:/projects/worktrees/rollback-failed',
    );
    const taskExecutionId = createTaskExecutionId('run-rollback', task.id);
    const input = {
      projectId: 'project-1',
      runId: 'run-rollback',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };
    const assignment = await allocator.allocate(input);

    await expect(allocator.release!(assignment)).rejects.toThrow(/rollback|确认/);
    await expect(allocator.allocate(input)).rejects.toThrow(/保留|复用|路径/);
  });

  it('does not clean a host-retained allocation when create returns null', async () => {
    const taskExecutionId = createTaskExecutionId('run-retained', task.id);
    const attemptId = createAttemptId(taskExecutionId, 1);
    const identitySegment = workerIdentitySegment(attemptId);
    const retainedInfo: WorktreeInfo = {
      id: `worker-${identitySegment}`,
      path: 'C:/projects/worktrees/retained/1',
      branch: `worker/${identitySegment}`,
      baseRevision: 'base-1',
      branchRevision: 'base-1',
      targetIdentity: 'target-retained',
      createdAt: '2026-09-01T00:00:01.000Z',
      status: 'created',
    };
    const create = vi.fn(async () => null);
    const get = vi.fn(() => retainedInfo);
    const cleanup = vi.fn(async () => false);
    const allocator = createWorktreeAllocator(
      { create, get, cleanup },
      () => retainedInfo.path,
    );
    const input = {
      projectId: 'project-1',
      runId: 'run-retained',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId,
    };

    let failure: unknown;
    try {
      await allocator.allocate(input);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WorkerAllocationRepairRequiredError);
    expect((failure as WorkerAllocationRepairRequiredError).allocation).toMatchObject({
      taskId: task.id,
      attempt: 1,
      taskExecutionId,
      attemptId: input.attemptId,
      assignment: {
        worktreeId: retainedInfo.id,
        path: retainedInfo.path,
        branch: retainedInfo.branch,
        baseRevision: retainedInfo.baseRevision,
        branchRevision: retainedInfo.branchRevision,
        targetIdentity: retainedInfo.targetIdentity,
      },
      worktreeStatus: 'orphaned',
    });
    expect(cleanup).not.toHaveBeenCalled();
    await expect(allocator.allocate(input)).rejects.toThrow(/保留|复用|路径/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
