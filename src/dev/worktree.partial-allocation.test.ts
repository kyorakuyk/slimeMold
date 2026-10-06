import { describe, expect, it, vi } from 'vitest';
import type { ProjectTask } from '../projectControl/types';
import { createAttemptId, createTaskExecutionId, workerIdentitySegment } from '../domain/execution';
import type { CommandResult } from './node-run';
import { WorktreeManager } from './worktree';
import { createWorktreeAllocator } from './workerAllocator';

const task: ProjectTask = {
  version: 1,
  id: 'task-partial-add',
  architectureId: 'architecture-1',
  title: '保留失败分配现场',
  description: '测试 git worktree add 退出前已创建分支的情况',
  moduleId: 'module-1',
  scope: ['src'],
  dependsOn: [],
  acceptanceCriteria: ['失败现场仍可修复'],
  category: 'implementation',
  status: 'approved',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

describe('partial worktree allocation repair', () => {
  it('retains branch-only lineage when worktree add exits nonzero after creating the branch', async () => {
    const baseRevision = 'a'.repeat(40);
    let addFinished = false;
    let branchReadbacks = 0;
    const git = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return result(0, `${baseRevision}\n`);
      }
      if (args[0] === 'show-ref') return addFinished ? result(0) : result(1);
      if (args[0] === 'worktree' && args[1] === 'add') {
        addFinished = true;
        return result(128, '', 'required smudge filter failed after branch creation');
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/heads/'))) {
        branchReadbacks += 1;
        return addFinished ? result(0, `${baseRevision}\n`) : result(1);
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return result(0, 'worktree C:/projects\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n');
      }
      return result(0);
    });
    const manager = new WorktreeManager({ git }, 'C:/projects');
    const taskExecutionId = createTaskExecutionId('run-partial-add', task.id);
    const attemptId = createAttemptId(taskExecutionId, 1);
    const identity = workerIdentitySegment(attemptId);
    const worktreeId = `worker-${identity}`;
    const branch = `worker/${identity}`;
    const path = `C:/projects-workers/${identity}`;
    const allocator = createWorktreeAllocator(manager, () => path);

    await expect(allocator.allocate({
      projectId: 'project-1',
      runId: 'run-partial-add',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId,
    })).rejects.toMatchObject({
      name: 'WorkerAllocationRepairRequiredError',
      allocation: {
        taskId: task.id,
        attempt: 1,
        taskExecutionId,
        attemptId,
        assignment: { worktreeId, path, branch, baseRevision, branchRevision: baseRevision },
        worktreeStatus: 'orphaned',
      },
    });

    expect(manager.get(worktreeId)).toMatchObject({
      id: worktreeId,
      path,
      branch,
      baseRevision,
      branchRevision: baseRevision,
      status: 'orphaned',
    });
    await expect(allocator.allocate({
      projectId: 'project-1',
      runId: 'run-partial-add',
      task,
      attempt: 1,
      taskExecutionId,
      attemptId,
    })).rejects.toThrow(/保留|复用|路径/);
    expect(branchReadbacks).toBeGreaterThan(0);
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['worktree', 'remove']), expect.anything());
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['update-ref', '-d']), expect.anything());
  });
});
