import { describe, expect, it } from 'vitest';
import {
  appendDomainEvent,
  approvePlanAndEnqueueRun,
  completeSideEffect,
  createApprovalGrant,
  createSideEffect,
  markSideEffectUnknown,
  replayDomainEvents,
  resolveExecutionPolicy,
  startSideEffect,
  validateApprovalGrant,
  validateWorkerCapability,
  type DomainEvent,
} from './contracts';
import { createAttemptId, createTaskExecutionId } from './execution';

const event = <TPayload>(partial: Partial<DomainEvent<TPayload>> & Pick<DomainEvent<TPayload>, 'eventType' | 'payload'>): DomainEvent<TPayload> => ({
  eventId: partial.eventId ?? `evt-${partial.sequence ?? 1}`,
  streamId: partial.streamId ?? 'project-1',
  sequence: partial.sequence ?? 1,
  aggregateType: partial.aggregateType ?? 'Task',
  aggregateId: partial.aggregateId ?? 'task-1',
  aggregateVersion: partial.aggregateVersion ?? 1,
  eventType: partial.eventType,
  schemaVersion: partial.schemaVersion ?? 1,
  payload: partial.payload,
  actor: partial.actor ?? 'runtime',
  occurredAt: partial.occurredAt ?? '2026-09-01T00:00:00.000Z',
});

describe('Phase 0a domain contracts', () => {
  it('appends and replays an event stream idempotently', () => {
    const created = event({
      eventId: 'evt-run-created',
      aggregateType: 'Run',
      aggregateId: 'run-1',
      eventType: 'RunCreated',
      payload: { runId: 'run-1' },
    });
    const started = event({
      eventId: 'evt-task-started',
      sequence: 2,
      aggregateType: 'Task',
      eventType: 'TaskStarted',
      payload: { taskId: 'task-1', runId: 'run-1' },
    });
    const succeeded = event({
      eventId: 'evt-task-succeeded',
      sequence: 3,
      aggregateType: 'Task',
      aggregateVersion: 2,
      eventType: 'TaskSucceeded',
      payload: { taskId: 'task-1', runId: 'run-1' },
    });
    const stream = appendDomainEvent(appendDomainEvent(appendDomainEvent([], created), started), succeeded);

    expect(appendDomainEvent(stream, succeeded)).toBe(stream);
    expect(replayDomainEvents(stream)).toMatchObject({
      lastSequence: 3,
      runs: { 'run-1': { status: 'queued' } },
      tasks: { 'task-1': { status: 'succeeded', runId: 'run-1' } },
    });
  });

  it('replays TaskQueued so an enqueued worker run survives projection rebuild', () => {
    const created = event({
      eventId: 'evt-run-created-queued',
      aggregateType: 'Run',
      aggregateId: 'run-queued',
      eventType: 'RunCreated',
      payload: { runId: 'run-queued' },
    });
    const queued = event({
      eventId: 'evt-task-queued',
      sequence: 2,
      aggregateType: 'Task',
      aggregateId: 'task-queued',
      eventType: 'TaskQueued',
      payload: { runId: 'run-queued' },
    });

    expect(replayDomainEvents([created, queued]).tasks['task-queued']).toEqual({
      status: 'queued',
      runId: 'run-queued',
    });
  });

  it('replays RunQueued after an explicit Worker recovery retry decision', () => {
    const queued = event({
      eventId: 'evt-run-requeued',
      aggregateType: 'Run',
      aggregateId: 'run-requeued',
      eventType: 'RunQueued',
      payload: { runId: 'run-requeued', recoveryDecisionId: 'decision-1' },
    });

    expect(replayDomainEvents([queued]).runs['run-requeued']).toEqual({ status: 'queued' });
  });

  it('replays host evidence and acceptance ids needed by cleanup proposals', () => {
    const succeeded = event({
      eventId: 'evt-task-succeeded-accepted',
      aggregateId: 'task-accepted',
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-accepted',
        evidenceIds: ['ev-1'],
        acceptanceId: 'acc-1',
      },
    });

    expect(replayDomainEvents([succeeded]).tasks['task-accepted']).toEqual({
      status: 'succeeded',
      runId: 'run-accepted',
      evidenceIds: ['ev-1'],
      acceptanceId: 'acc-1',
    });
  });

  it('replays failed host evidence and acceptance ids for recovery review', () => {
    const failed = event({
      eventId: 'evt-task-failed-accepted',
      aggregateId: 'task-failed-accepted',
      eventType: 'TaskFailed',
      payload: {
        runId: 'run-failed-accepted',
        evidenceIds: ['ev-test', 'ev-diff', 'ev-policy'],
        acceptanceId: 'acc-failed-1',
      },
    });

    expect(replayDomainEvents([failed]).tasks['task-failed-accepted']).toEqual({
      status: 'failed',
      runId: 'run-failed-accepted',
      evidenceIds: ['ev-test', 'ev-diff', 'ev-policy'],
      acceptanceId: 'acc-failed-1',
    });
  });

  it('replays TaskCleaned without losing the cleanup receipt binding', () => {
    const cleaned = event({
      eventId: 'evt-task-cleaned',
      aggregateId: 'task-cleaned',
      eventType: 'TaskCleaned',
      payload: { runId: 'run-cleaned', receiptId: 'cleanup-receipt-1' },
    });

    expect(replayDomainEvents([cleaned]).tasks['task-cleaned']).toEqual({
      status: 'succeeded',
      runId: 'run-cleaned',
      cleanupStatus: 'cleaned',
      cleanupReceiptId: 'cleanup-receipt-1',
    });
  });

  it('keeps separate task executions and attempts when one task runs twice', () => {
    const firstExecutionId = createTaskExecutionId('run-a', 'task-1');
    const secondExecutionId = createTaskExecutionId('run-b', 'task-1');
    const firstAttemptId = createAttemptId(firstExecutionId, 1);
    const secondAttemptId = createAttemptId(secondExecutionId, 1);
    const projection = replayDomainEvents([
      event({
        eventId: 'run-a-queued',
        aggregateType: 'Run',
        aggregateId: 'run-a',
        eventType: 'RunQueued',
        payload: { runId: 'run-a' },
      }),
      event({
        eventId: 'run-a-task-queued',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: firstExecutionId,
        eventType: 'TaskQueued',
        payload: { runId: 'run-a', taskId: 'task-1', taskExecutionId: firstExecutionId },
      }),
      event({
        eventId: 'run-a-task-started',
        sequence: 3,
        aggregateType: 'TaskExecution',
        aggregateId: firstExecutionId,
        eventType: 'TaskStarted',
        payload: {
          runId: 'run-a',
          taskId: 'task-1',
          taskExecutionId: firstExecutionId,
          attemptId: firstAttemptId,
          attempt: 1,
          worktreeId: 'worktree-a',
        },
      }),
      event({
        eventId: 'run-a-task-failed',
        sequence: 4,
        aggregateType: 'TaskExecution',
        aggregateId: firstExecutionId,
        eventType: 'TaskFailed',
        payload: {
          runId: 'run-a',
          taskId: 'task-1',
          taskExecutionId: firstExecutionId,
          attemptId: firstAttemptId,
          attempt: 1,
          evidenceIds: ['evidence-a'],
        },
      }),
      event({
        eventId: 'run-b-queued',
        sequence: 5,
        aggregateType: 'Run',
        aggregateId: 'run-b',
        eventType: 'RunQueued',
        payload: { runId: 'run-b' },
      }),
      event({
        eventId: 'run-b-task-queued',
        sequence: 6,
        aggregateType: 'TaskExecution',
        aggregateId: secondExecutionId,
        eventType: 'TaskQueued',
        payload: { runId: 'run-b', taskId: 'task-1', taskExecutionId: secondExecutionId },
      }),
      event({
        eventId: 'run-b-task-started',
        sequence: 7,
        aggregateType: 'TaskExecution',
        aggregateId: secondExecutionId,
        eventType: 'TaskStarted',
        payload: {
          runId: 'run-b',
          taskId: 'task-1',
          taskExecutionId: secondExecutionId,
          attemptId: secondAttemptId,
          attempt: 1,
          worktreeId: 'worktree-b',
        },
      }),
      event({
        eventId: 'run-b-task-succeeded',
        sequence: 8,
        aggregateType: 'TaskExecution',
        aggregateId: secondExecutionId,
        eventType: 'TaskSucceeded',
        payload: {
          runId: 'run-b',
          taskId: 'task-1',
          taskExecutionId: secondExecutionId,
          attemptId: secondAttemptId,
          attempt: 1,
          evidenceIds: ['evidence-b'],
        },
      }),
    ]);

    expect(Object.keys(projection.taskExecutions)).toEqual([firstExecutionId, secondExecutionId]);
    expect(projection.taskExecutions[firstExecutionId]).toMatchObject({
      taskId: 'task-1',
      runId: 'run-a',
      status: 'failed',
      attemptIds: [firstAttemptId],
      currentAttemptId: firstAttemptId,
    });
    expect(projection.attempts[firstAttemptId]).toMatchObject({
      taskExecutionId: firstExecutionId,
      taskId: 'task-1',
      runId: 'run-a',
      attempt: 1,
      status: 'failed',
      evidenceIds: ['evidence-a'],
    });
    expect(projection.taskExecutions[secondExecutionId]).toMatchObject({
      taskId: 'task-1',
      runId: 'run-b',
      status: 'succeeded',
      attemptIds: [secondAttemptId],
    });
    expect(projection.tasks['task-1']).toMatchObject({
      status: 'succeeded',
      runId: 'run-b',
      evidenceIds: ['evidence-b'],
    });
  });

  it('does not carry the previous attempt acceptance into a queued retry', () => {
    const taskExecutionId = createTaskExecutionId('run-retry', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const projection = replayDomainEvents([
      event({ eventId: 'retry-run-queued', aggregateType: 'Run', aggregateId: 'run-retry', eventType: 'RunQueued', payload: { runId: 'run-retry' } }),
      event({
        eventId: 'retry-task-started',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        eventType: 'TaskStarted',
        payload: { runId: 'run-retry', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
      }),
      event({
        eventId: 'retry-task-succeeded',
        sequence: 3,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        eventType: 'TaskSucceeded',
        payload: {
          runId: 'run-retry',
          taskId: 'task-1',
          taskExecutionId,
          attempt: 1,
          attemptId,
          evidenceIds: ['old-evidence'],
          acceptanceId: 'old-acceptance',
        },
      }),
      event({
        eventId: 'retry-task-queued',
        sequence: 4,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        eventType: 'TaskQueued',
        payload: {
          runId: 'run-retry',
          taskId: 'task-1',
          taskExecutionId,
          nextAttempt: 2,
        },
      }),
    ]);

    expect(projection.taskExecutions[taskExecutionId]).toMatchObject({
      status: 'queued',
      attemptIds: [attemptId],
    });
    expect(projection.taskExecutions[taskExecutionId].evidenceIds).toBeUndefined();
    expect(projection.taskExecutions[taskExecutionId].acceptanceId).toBeUndefined();
    expect(projection.attempts[attemptId]).toMatchObject({
      status: 'succeeded',
      evidenceIds: ['old-evidence'],
      acceptanceId: 'old-acceptance',
    });
  });

  it('rejects a TaskExecution event whose aggregate id disagrees with its lineage', () => {
    const taskExecutionId = createTaskExecutionId('run-lineage', 'task-1');

    expect(() => replayDomainEvents([event({
      eventId: 'mismatched-task-execution',
      aggregateType: 'TaskExecution',
      aggregateId: 'task-execution:wrong',
      eventType: 'TaskQueued',
      payload: {
        runId: 'run-lineage',
        taskId: 'task-1',
        taskExecutionId,
      },
    })])).toThrow(/aggregateId/);
  });

  it('resolves global, project, and run policy without mutating the global preference', () => {
    const global = {
      sandboxMode: 'workspace-write' as const,
      objective: 'balanced' as const,
      autoPush: false,
      managerMerge: false,
    };
    const project = {
      projectId: 'project-1',
      sandboxMode: 'danger-full-access' as const,
      autoPush: true,
      riskAcceptedAt: '2026-09-01T00:00:00.000Z',
      riskAcceptedBy: 'user',
    };
    const run = { objective: 'cost-first' as const };

    const resolved = resolveExecutionPolicy(global, project, run);

    expect(resolved.policy).toMatchObject({
      projectId: 'project-1',
      sandboxMode: 'danger-full-access',
      objective: 'cost-first',
      autoPush: true,
      managerMerge: false,
    });
    expect(resolved.sources.sandboxMode).toBe('project');
    expect(resolved.sources.objective).toBe('run');
    expect(resolved.requiresRiskAcceptance).toBe(false);
    expect(global).toEqual({
      sandboxMode: 'workspace-write',
      objective: 'balanced',
      autoPush: false,
      managerMerge: false,
    });
  });

  it('binds approval to plan/policy/base hashes and enqueues approval atomically', () => {
    const grant = createApprovalGrant({
      id: 'grant-1',
      planHash: 'plan-v1',
      policyHash: 'policy-v1',
      baseRevision: 'commit-a',
      worktreePath: 'D:/repo/.slime-wt/task-1',
      targetRef: 'refs/heads/feature/task-1',
      capabilities: ['codex.write', 'test.run'],
      approvedBy: 'user',
      approvedAt: '2026-09-01T00:00:00.000Z',
    });
    const current = {
      planHash: 'plan-v1',
      policyHash: 'policy-v1',
      baseRevision: 'commit-a',
      worktreePath: 'D:/repo/.slime-wt/task-1',
      targetRef: 'refs/heads/feature/task-1',
      capabilities: ['codex.write', 'test.run'],
    };

    expect(validateApprovalGrant(grant, current)).toEqual({ ok: true });
    expect(validateApprovalGrant(grant, { ...current, planHash: 'plan-v2' }).ok).toBe(false);
    expect(approvePlanAndEnqueueRun({
      grant,
      current,
      streamId: 'project-1',
      runId: 'run-1',
      sequence: 10,
      projectVersion: 1,
      now: '2026-09-01T00:01:00.000Z',
    })).toEqual([
      expect.objectContaining({ eventType: 'PlanApproved', aggregateVersion: 2 }),
      expect.objectContaining({ eventType: 'RunCreated', aggregateVersion: 1 }),
    ]);
  });

  it('rejects Planner write access and accepts a Worker in a dedicated worktree', () => {
    expect(validateWorkerCapability({
      kind: 'planner',
      projectRoot: 'D:/repo',
      worktreePath: 'D:/repo',
      sandboxMode: 'workspace-write',
      canWrite: true,
      tools: ['filesystem.write'],
    }).ok).toBe(false);

    expect(validateWorkerCapability({
      kind: 'worker',
      projectRoot: 'D:/repo',
      worktreePath: 'D:/repo/.slime-wt/task-1',
      sandboxMode: 'workspace-write',
      canWrite: true,
      tools: ['filesystem.write', 'shell.test'],
    })).toEqual({ ok: true });
  });

  it('requires a user decision for unknown side effects and skips receipts', () => {
    const planned = createSideEffect({
      idempotencyKey: 'push:task-1:commit-a',
      kind: 'push',
      target: 'refs/heads/feature/task-1',
      inputHash: 'tree-a',
    });
    const started = startSideEffect(planned);
    const unknown = markSideEffectUnknown(started, 'process-crashed');

    expect(unknown.status).toBe('unknown');
    expect(unknown.recovery).toBe('needs-user');

    const completed = completeSideEffect(started, {
      receiptId: 'receipt-1',
      observedAt: '2026-09-01T00:02:00.000Z',
      outputHash: 'remote-tree-a',
    });
    expect(completed.status).toBe('receipt');
    expect(completed.recovery).toBe('skip');
  });
});
