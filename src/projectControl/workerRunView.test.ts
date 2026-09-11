import { describe, expect, it } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from './workerCleanup';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { workerRunViewsFor } from './workerRunView';

function run(overrides: Partial<WorkerRunQueueState> = {}): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'partial',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'failed',
        attempt: 1,
        evidenceIds: ['evidence-1'],
        error: '测试失败',
        worktreePath: 'C:/worktrees/task-1',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
      'task-2': {
        taskId: 'task-2',
        status: 'blocked',
        attempt: 0,
        evidenceIds: [],
        error: '依赖 task-1 未完成',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
    ...overrides,
  };
}

const recovery: WorkerRunRecovery = {
  runId: 'run-1',
  projectId: 'project-1',
  reason: 'unfinished-worker-lease',
  message: '检测到未闭合 Worker lease',
};

describe('workerRunViewsFor', () => {
  it('projects task failures, blocked impact, evidence ids, and recovery without changing source state', () => {
    const source = run();
    const evidence: EvidenceRecord[] = [{
      id: 'evidence-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      kind: 'test',
      status: 'passed',
      command: 'npm run test',
      exitCode: 0,
      summary: '宿主测试通过',
      capturedBy: 'host',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreePath: 'C:/worktrees/task-1',
      createdAt: '2026-09-01T00:01:00.000Z',
    }];
    const sideEffects: SideEffectRecord[] = [{
      idempotencyKey: 'worker-exec:run-1:task-1:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'task-1:1:1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      status: 'receipt',
      recovery: 'skip',
      receipt: { receiptId: 'receipt-1', observedAt: '2026-09-01T00:01:00.000Z' },
    }];
    const cleanupProposals: WorkerCleanupProposal[] = [{
      status: 'blocked',
      runId: 'run-1',
      taskId: 'task-1',
      reason: '任务状态为 failed',
    }];
    const views = workerRunViewsFor([source], [recovery], 'orch-1', evidence, sideEffects, cleanupProposals);

    expect(views).toEqual([expect.objectContaining({
      runId: 'run-1',
      status: 'partial',
      recovery,
      tasks: [
        expect.objectContaining({
          status: 'failed',
          error: '测试失败',
          evidenceIds: ['evidence-1'],
          taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
          attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
        }),
        expect.objectContaining({ status: 'blocked', error: '依赖 task-1 未完成' }),
      ],
    })]);
    expect(views[0].tasks[0].evidence).toEqual([
      expect.objectContaining({ id: 'evidence-1', kind: 'test', exitCode: 0, summary: '宿主测试通过' }),
    ]);
    expect(views[0].tasks[0].sideEffects).toEqual([
      expect.objectContaining({
        idempotencyKey: 'worker-exec:run-1:task-1:attempt-1',
        status: 'receipt',
        receiptId: 'receipt-1',
        taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
        attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      }),
    ]);
    expect(views[0].tasks[0].cleanup).toEqual(cleanupProposals[0]);
    expect(source.tasks['task-1'].status).toBe('failed');
  });

  it('does not show prior-attempt evidence or side effects for an explicit current attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const currentAttemptId = createAttemptId(taskExecutionId, 2);
    const source = run({
      tasks: {
        ...run().tasks,
        'task-1': {
          ...run().tasks['task-1'],
          taskExecutionId,
          currentAttemptId,
          attempt: 2,
          evidenceIds: ['old-evidence', 'current-evidence'],
        },
      },
    });
    const evidence: EvidenceRecord[] = [
      {
        id: 'old-evidence',
        orchestrationId: 'orch-1',
        stageId: 'task-1',
        kind: 'test',
        status: 'failed',
        summary: 'attempt 1',
        capturedBy: 'host',
        taskExecutionId,
        attemptId: createAttemptId(taskExecutionId, 1),
        worktreePath: 'C:/worktrees/task-1',
        createdAt: '2026-09-01T00:00:01.000Z',
      },
      {
        id: 'current-evidence',
        orchestrationId: 'orch-1',
        stageId: 'task-1',
        kind: 'test',
        status: 'passed',
        summary: 'attempt 2',
        capturedBy: 'host',
        taskExecutionId,
        attemptId: currentAttemptId,
        worktreePath: 'C:/worktrees/task-1',
        createdAt: '2026-09-01T00:00:02.000Z',
      },
    ];
    const sideEffects: SideEffectRecord[] = [
      {
        idempotencyKey: 'effect-old',
        kind: 'worker-execution',
        target: 'worktree-1',
        inputHash: 'old',
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId,
        attemptId: createAttemptId(taskExecutionId, 1),
        status: 'unknown',
        recovery: 'needs-user',
      },
      {
        idempotencyKey: 'effect-current',
        kind: 'worker-execution',
        target: 'worktree-2',
        inputHash: 'current',
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId,
        attemptId: currentAttemptId,
        status: 'started',
        recovery: 'retry',
      },
    ];
    const views = workerRunViewsFor([source], [], 'orch-1', evidence, sideEffects, []);

    expect(views[0].tasks[0].evidence.map((item) => item.id)).toEqual(['current-evidence']);
    expect(views[0].tasks[0].sideEffects.map((item) => item.idempotencyKey)).toEqual(['effect-current']);
  });

  it('does not project an old attempt as active for a queued retry', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const queued = run({
      status: 'queued',
      tasks: {
        ...run().tasks,
        'task-1': {
          ...run().tasks['task-1'],
          status: 'queued',
          attempt: 1,
          evidenceIds: [],
          currentAttemptId: undefined,
          taskExecutionId,
        },
      },
    });
    const oldEffect: SideEffectRecord = {
      idempotencyKey: 'old-attempt',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'old',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
      status: 'unknown',
      recovery: 'needs-user',
    };

    const views = workerRunViewsFor([queued], [], 'orch-1', [], [oldEffect], []);

    expect(views[0].tasks[0].sideEffects).toEqual([]);
  });

  it('filters runs to the selected orchestration and leaves missing recovery undefined', () => {
    const views = workerRunViewsFor([
      run(),
      run({ runId: 'run-2', orchestrationId: 'other-orch', status: 'succeeded' }),
    ], [], 'orch-1');

    expect(views).toHaveLength(1);
    expect(views[0].recovery).toBeUndefined();
  });
});
