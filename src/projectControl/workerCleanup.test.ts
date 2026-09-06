import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceRecord } from '../dev/session';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
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
        branch: 'worker/task-1',
        baseRevision: 'abc123',
        worktreeStatus: 'created',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
  };
}

function acceptance(): AcceptanceRecord {
  const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
  return {
    acceptanceId: 'acc-1',
    orchestrationId: 'orch-1',
    stageId: 'task-1',
    worktreePath: 'C:/project-workers/run-1/task-1',
    passed: true,
    failedChecks: [],
    at: '2026-09-01T00:01:00.000Z',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId,
    attemptId: createAttemptId(taskExecutionId, 1),
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
      sideEffects: [],
    });

    expect(proposal).toEqual({
      status: 'ready',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreeId: 'wt-1',
      branch: 'worker/task-1',
      worktreePath: 'C:/project-workers/run-1/task-1',
      baseRevision: 'abc123',
      stateSignature: 'sig-1',
      acceptanceId: 'acc-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      taskStatus: 'succeeded',
      cleanupStatus: 'active',
    });
    expect(computeWorktreeSignature).toHaveBeenCalledWith('C:/project-workers/run-1/task-1');
  });

  it('binds cleanup to the Acceptance stage when it differs from the task id', async () => {
    const task = { ...run().tasks['task-1'], acceptanceStageId: 'verify' };
    const proposal = await buildWorkerCleanupProposal({
      run: run(),
      task,
      acceptance: { ...acceptance(), stageId: 'verify' },
      computeWorktreeSignature: vi.fn(async () => 'sig-stage'),
      sideEffects: [],
    });

    expect(proposal).toEqual(expect.objectContaining({
      status: 'ready',
      stageId: 'verify',
    }));
  });

  it('blocks an Acceptance stage that is not declared by the Worker task', async () => {
    const proposal = await buildWorkerCleanupProposal({
      run: run(),
      task: run().tasks['task-1'],
      acceptance: { ...acceptance(), stageId: 'verify' },
      computeWorktreeSignature: vi.fn(async () => 'sig-stage'),
      sideEffects: [],
    });

    expect(proposal).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringMatching(/stage|阶段/),
    }));
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
      sideEffects: [],
    })).resolves.toEqual(expect.objectContaining({ status: 'blocked' }));
    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: run().tasks['task-1'],
      acceptance: failedAcceptance,
      computeWorktreeSignature,
      sideEffects: [],
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
      sideEffects: [],
    })).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'worktree 未被当前宿主登记，不能清理',
    }));
    expect(computeWorktreeSignature).not.toHaveBeenCalled();
  });

  it('rebuilds an orphan proposal from durable branch provenance without live worktree access', async () => {
    const computeWorktreeSignature = vi.fn(async () => 'should-not-run');
    const task = {
      ...run().tasks['task-1'],
      worktreeStatus: 'orphaned' as const,
      branchRevision: 'b'.repeat(40),
      cleanupStateSignature: 'sig-before-removal',
    };

    const proposal = await buildWorkerCleanupProposal({
      run: run(),
      task,
      acceptance: acceptance(),
      isWorktreeTracked: () => false,
      computeWorktreeSignature,
      sideEffects: [],
    });

    expect(proposal).toEqual(expect.objectContaining({
      status: 'ready',
      worktreeId: 'wt-1',
      branch: 'worker/task-1',
      branchRevision: 'b'.repeat(40),
      stateSignature: 'sig-before-removal',
    }));
    expect(computeWorktreeSignature).not.toHaveBeenCalled();
  });

  it('blocks orphan cleanup when durable branch revision is missing', async () => {
    const task = {
      ...run().tasks['task-1'],
      worktreeStatus: 'orphaned' as const,
      cleanupStateSignature: 'sig-before-removal',
    };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task,
      acceptance: acceptance(),
      isWorktreeTracked: () => false,
      computeWorktreeSignature: vi.fn(async () => 'should-not-run'),
      sideEffects: [],
    })).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringMatching(/branchRevision/),
    }));
  });

  it('blocks a legacy acceptance without lineage for a task with explicit lineage', async () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const task = {
      ...run().tasks['task-1'],
      taskExecutionId,
      currentAttemptId: createAttemptId(taskExecutionId, 1),
    };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task,
      acceptance: {
        ...acceptance(),
        runId: undefined,
        taskId: undefined,
        taskExecutionId: undefined,
        attemptId: undefined,
      },
      computeWorktreeSignature: vi.fn(async () => 'never'),
      sideEffects: [],
    })).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'acceptance 未通过或未绑定当前 Run/Task/worktree/attempt',
    }));
  });

  it('blocks cleanup when acceptance belongs to a different attempt', async () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const task = {
      ...run().tasks['task-1'],
      attempt: 2,
      taskExecutionId,
      currentAttemptId: createAttemptId(taskExecutionId, 2),
    };
    const oldAcceptance = {
      ...acceptance(),
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task,
      acceptance: oldAcceptance,
      computeWorktreeSignature: vi.fn(async () => 'never'),
      sideEffects: [],
    })).resolves.toEqual(expect.objectContaining({
      status: 'blocked',
      reason: 'acceptance 未通过或未绑定当前 Run/Task/worktree/attempt',
    }));
  });

  it('projects a cleaned task as a terminal proposal instead of asking to clean it again', async () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const cleanupKey = `cleanup:${attemptId}`;
    const cleanedTask = {
      ...run().tasks['task-1'],
      taskExecutionId,
      currentAttemptId: attemptId,
      cleanupStatus: 'cleaned' as const,
      cleanupReceiptId: `${cleanupKey}:receipt`,
    };

    await expect(buildWorkerCleanupProposal({
      run: run(),
      task: cleanedTask,
      acceptance: acceptance(),
      isWorktreeTracked: () => false,
      computeWorktreeSignature: vi.fn(async () => 'never'),
      sideEffects: [{
        idempotencyKey: cleanupKey,
        kind: 'worktree-cleanup',
        target: 'wt-1',
        inputHash: 'abc123:sig-1',
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId,
        attemptId,
        status: 'receipt',
        recovery: 'skip',
        receipt: { receiptId: `${cleanupKey}:receipt`, observedAt: '2026-09-01T00:02:00.000Z', outcome: 'succeeded', outputHash: 'sig-1' },
      }],
    })).resolves.toEqual({
      status: 'cleaned',
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      receiptId: `${cleanupKey}:receipt`,
    });
  });
});
