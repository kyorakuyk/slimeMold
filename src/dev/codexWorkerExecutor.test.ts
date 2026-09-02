import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexWorkerPrompt,
  createCodexWorkerInvoker,
  createCodexWorkerExecutor,
} from './codexWorkerExecutor';
import type { WorkerTaskLease } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { ProjectTask } from '../projectControl/types';

const task: ProjectTask = {
  version: 1,
  id: 'task-1',
  architectureId: 'architecture-1',
  title: '实现 Worker 队列',
  description: '在隔离 worktree 中完成队列执行器',
  moduleId: 'module-1',
  scope: ['src/domain/workerQueue.ts', 'src/dev/workerAllocator.ts'],
  dependsOn: [],
  acceptanceCriteria: ['npm run test 通过', '没有跨 worktree 写入'],
  category: 'implementation',
  status: 'approved',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const lease: WorkerTaskLease = {
  runId: 'run-1',
  task,
  assignment: {
    worktreeId: 'worktree-1',
    path: 'C:/worktrees/task-1',
    branch: 'worker/task-1',
    baseRevision: 'base-1',
  },
  attempt: 1,
  taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
  attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
};

describe('Codex Worker executor', () => {
  it('builds a bounded prompt with task scope, acceptance, and no-push guardrails', () => {
    const prompt = buildCodexWorkerPrompt(lease);
    expect(prompt).toContain('实现 Worker 队列');
    expect(prompt).toContain('src/domain/workerQueue.ts');
    expect(prompt).toContain('npm run test 通过');
    expect(prompt).toContain('不要 push、merge、release 或删除远程资源');
    expect(prompt).toContain('C:/worktrees/task-1');
  });

  it('requires host acceptance before returning succeeded with evidence ids', async () => {
    const execute = vi.fn(async (input: { prompt: string; model?: string; cwd: string }) => {
      expect(input.cwd).toBe('C:/worktrees/task-1');
      expect(input.model).toBe('gpt-worker');
      return { text: '已完成修改' };
    });
    const evaluate = vi.fn(async () => ({ passed: true, evidenceIds: ['evidence-test', 'evidence-diff'] }));
    const executor = createCodexWorkerExecutor({
      invoker: { execute },
      model: 'gpt-worker',
      acceptance: { evaluate },
    });

    await expect(executor.execute(lease)).resolves.toEqual({
      status: 'succeeded',
      evidenceIds: ['evidence-test', 'evidence-diff'],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns failed when host acceptance rejects the model result', async () => {
    const evaluate = vi.fn(async () => ({
      passed: false,
      evidenceIds: ['evidence-test', 'evidence-diff', 'evidence-policy'],
      acceptanceId: 'acceptance-1',
      failureReason: '测试失败',
    }));
    const executor = createCodexWorkerExecutor({
      invoker: { execute: async () => ({ text: '模型声称完成' }) },
      acceptance: { evaluate },
    });

    await expect(executor.execute(lease)).resolves.toEqual({
      status: 'failed',
      evidenceIds: ['evidence-test', 'evidence-diff', 'evidence-policy'],
      acceptanceId: 'acceptance-1',
      error: '测试失败',
    });
  });

  it('returns failed without calling acceptance when Codex produces no final message', async () => {
    const evaluate = vi.fn(async () => ({ passed: true, evidenceIds: ['should-not-exist'] }));
    const executor = createCodexWorkerExecutor({
      invoker: { execute: async () => ({ text: '  ' }) },
      acceptance: { evaluate },
    });

    await expect(executor.execute(lease)).resolves.toEqual({
      status: 'failed',
      error: 'Codex Worker 没有返回最终消息',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('provides the real Codex provider as an invoker while retaining desktop fail-closed behavior', async () => {
    const invoker = createCodexWorkerInvoker();
    await expect(invoker.execute({
      prompt: 'implement task',
      cwd: 'C:/worktrees/task-1',
    })).rejects.toThrow(/桌面版/);
  });
});
