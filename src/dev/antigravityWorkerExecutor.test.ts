import { describe, expect, it, vi } from 'vitest';
import type { WorkerTaskLease } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { createAntigravityWorkerExecutor } from './antigravityWorkerExecutor';
import type { WorkerAcceptance } from './codexWorkerExecutor';

const task = {
  version: 1 as const,
  id: 'task-antigravity',
  architectureId: 'architecture-1',
  title: 'Antigravity task',
  description: 'Use the interactive runtime',
  moduleId: 'module-1',
  scope: ['src/feature.ts'],
  dependsOn: [],
  acceptanceCriteria: ['host acceptance passes'],
  category: 'implementation',
  status: 'approved' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const taskExecutionId = createTaskExecutionId('run-antigravity', task.id);
const lease: WorkerTaskLease = {
  projectId: 'project-antigravity',
  runId: 'run-antigravity',
  task,
  assignment: {
    worktreeId: 'worktree-antigravity',
    path: 'C:/worktrees/antigravity',
    branch: 'worker/antigravity',
    baseRevision: 'base-1',
  },
  attempt: 1,
  taskExecutionId,
  attemptId: createAttemptId(taskExecutionId, 1),
};

function acceptance(passed: boolean): WorkerAcceptance {
  return {
    evaluate: vi.fn(async () => passed
      ? { passed: true, evidenceIds: ['evidence-antigravity'], acceptanceId: 'acceptance-antigravity' }
      : { passed: false, evidenceIds: ['evidence-antigravity'], acceptanceId: 'acceptance-antigravity', failureReason: 'test failure' }),
  };
}

describe('Antigravity Worker executor', () => {
  it('runs Host Acceptance after a completed interactive Attempt', async () => {
    const evaluate = acceptance(true);
    const executor = createAntigravityWorkerExecutor({
      generation: 1,
      acceptance: evaluate,
      invoker: {
        execute: vi.fn(async () => ({
          outcome: 'completed' as const,
          text: 'Antigravity reports ready',
          sessionDir: 'C:/worktrees/antigravity/.agents/slimemold-worker/op-1',
        })),
      },
    });

    await expect(executor.execute(lease)).resolves.toEqual({
      status: 'succeeded',
      evidenceIds: ['evidence-antigravity'],
      acceptanceId: 'acceptance-antigravity',
    });
    expect(evaluate.evaluate).toHaveBeenCalledTimes(1);
  });

  it('turns an interactive blocker into a bounded FeedbackRequest', async () => {
    const executor = createAntigravityWorkerExecutor({
      generation: 1,
      acceptance: acceptance(true),
      invoker: {
        execute: vi.fn(async () => ({
          outcome: 'blocked' as const,
          text: 'The agent needs a decision',
          sessionDir: 'C:/worktrees/antigravity/.agents/slimemold-worker/op-1',
        })),
      },
    });

    const result = await executor.execute(lease);
    expect(result.status).toBe('waiting-feedback');
    if (result.status !== 'waiting-feedback') throw new Error('expected feedback');
    expect(result.feedbackRequest?.projectId).toBe('project-antigravity');
    expect(result.feedbackRequest?.taskId).toBe('task-antigravity');
    expect(result.feedbackRequest?.attemptId).toBe(lease.attemptId);
    expect(result.feedbackRequest?.blocking).toBe(true);
  });
});
