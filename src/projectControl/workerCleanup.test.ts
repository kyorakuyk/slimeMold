import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceRecord } from '../dev/session';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { buildWorkerCleanupProposal } from './workerCleanup';

function run(): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'succeeded',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'succeeded',
        attempt: 1,
        evidenceIds: ['ev-1'],
        acceptanceId: 'acc-1',
        worktreeId: 'wt-1',
        worktreePath: 'C:/project-workers/run-1/task-1',
        baseRevision: 'abc123',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
  };
}

function acceptance(): AcceptanceRecord {
  return {
    acceptanceId: 'acc-1',
    orchestrationId: 'orch-1',
    stageId: 'task-1',
    worktreePath: 'C:/project-workers/run-1/task-1',
    passed: true,
    failedChecks: [],
    at: '2026-09-01T00:01:00.000Z',
  };
}

describe('worker cleanup proposal', () => {
  it('binds cleanup to the accepted worktree baseline and current signature', async () => {
    const computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const proposal = await buildWorkerCleanupProposal({
      run: run(),
      task: run().tasks['task-1'],
      acceptance: acceptance(),
      computeWorktreeSignature,
    });

    expect(proposal).toEqual({
      status: 'ready',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      worktreePath: 'C:/project-workers/run-1/task-1',
      baseRevision: 'abc123',
      stateSignature: 'sig-1',
      acceptanceId: 'acc-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
    });
    expect(computeWorktreeSignature).toHaveBeenCalledWith('C:/project-workers/run-1/task-1');
  });

  it('blocks cleanup when the task or acceptance is not safely complete', async () => {
    const computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const incomplete = { ...run().tasks['task-1'], status: 'failed' as const };
    const failedAcceptance = { ...acceptance(), passed: false, failedChecks: ['tests'] };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: incomplete,
      acceptance: acceptance(),
      computeWorktreeSignature,
    })).resolves.toEqual(expect.objectContaining({ status: 'blocked' }));
    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: run().tasks['task-1'],
      acceptance: failedAcceptance,
      computeWorktreeSignature,
    })).resolves.toEqual(expect.objectContaining({ status: 'blocked' }));
    expect(computeWorktreeSignature).not.toHaveBeenCalled();
  });

  it('blocks cleanup when the host cannot verify the worktree is still live', async () => {
    const computeWorktreeSignature = vi.fn(async () => 'sig-1');

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: run().tasks['task-1'],
      acceptance: acceptance(),
      isWorktreeTracked: () => false,
      computeWorktreeSignature,
    })).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'worktree 未被当前宿主登记，不能清理',
    }));
    expect(computeWorktreeSignature).not.toHaveBeenCalled();
  });

  it('projects a cleaned task as a terminal proposal instead of asking to clean it again', async () => {
    const cleanedTask = { ...run().tasks['task-1'], cleanupStatus: 'cleaned' as const, cleanupReceiptId: 'receipt-cleanup-1' };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: cleanedTask,
      acceptance: acceptance(),
      isWorktreeTracked: () => false,
      computeWorktreeSignature: vi.fn(async () => 'never'),
    })).resolves.toEqual({
      status: 'cleaned',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      receiptId: 'receipt-cleanup-1',
    });
  });
});
