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
      payload: {
        taskId: 'task-1',
        runId: 'run-1',
        evidenceIds: ['evidence-1'],
        acceptanceId: 'acceptance-1',
      },
    });
    const stream = appendDomainEvent(appendDomainEvent(appendDomainEvent([], created), started), succeeded);

    expect(appendDomainEvent(stream, succeeded)).toBe(stream);
    expect(replayDomainEvents(stream)).toMatchObject({
      lastSequence: 3,
      runs: { 'run-1': { status: 'queued' } },
      tasks: { 'task-1': { status: 'succeeded', runId: 'run-1' } },
    });
  });

  it('rejects malformed Evidence members instead of filtering them during replay', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'mixed-evidence',
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-mixed-evidence',
        evidenceIds: ['evidence-valid', 42],
        acceptanceId: 'acceptance-valid',
      },
    })])).toThrow(/Evidence/);
  });

  it('rejects RunSucceeded without a complete non-empty task set', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'empty-run-success',
      aggregateType: 'Run',
      aggregateId: 'run-empty-success',
      eventType: 'RunSucceeded',
      payload: { runId: 'run-empty-success' },
    })])).toThrow(/RunSucceeded|provenance|task/i);
  });

  it('rejects TaskCleaned without a preceding succeeded task', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'orphan-cleaned',
      eventType: 'TaskCleaned',
      payload: { runId: 'run-orphan-cleaned', receiptId: 'cleanup-receipt-1' },
    })])).toThrow(/TaskCleaned|succeeded|Attempt/i);
  });
  it('replays an unknown interrupted attempt before a retry attempt starts', () => {
    const taskExecutionId = createTaskExecutionId('run-replay-retry', 'task-1');
    const attempt1 = createAttemptId(taskExecutionId, 1);
    const attempt2 = createAttemptId(taskExecutionId, 2);
    const events = [
      event({ eventId: 'retry-queued-0', aggregateType: 'TaskExecution', aggregateId: taskExecutionId, eventType: 'TaskQueued', payload: { runId: 'run-replay-retry', taskId: 'task-1', taskExecutionId } }),
      event({ eventId: 'retry-started-1', sequence: 2, aggregateType: 'TaskExecution', aggregateId: taskExecutionId, aggregateVersion: 2, eventType: 'TaskStarted', payload: { runId: 'run-replay-retry', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId: attempt1 } }),
      event({ eventId: 'retry-unknown-1', sequence: 3, aggregateType: 'TaskExecution', aggregateId: taskExecutionId, aggregateVersion: 3, eventType: 'TaskAttemptMarkedUnknown', payload: { runId: 'run-replay-retry', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId: attempt1, reason: 'process exited' } }),
      event({ eventId: 'retry-queued-2', sequence: 4, aggregateType: 'TaskExecution', aggregateId: taskExecutionId, aggregateVersion: 4, eventType: 'TaskQueued', payload: { runId: 'run-replay-retry', taskId: 'task-1', taskExecutionId, nextAttempt: 2 } }),
      event({ eventId: 'retry-started-2', sequence: 5, aggregateType: 'TaskExecution', aggregateId: taskExecutionId, aggregateVersion: 5, eventType: 'TaskStarted', payload: { runId: 'run-replay-retry', taskId: 'task-1', taskExecutionId, attempt: 2, attemptId: attempt2 } }),
    ];
    const projection = replayDomainEvents(events);
    expect(projection.attempts[attempt1]).toMatchObject({ status: 'unknown', attempt: 1 });
    expect(projection.attempts[attempt2]).toMatchObject({ status: 'running', attempt: 2 });
    expect(projection.taskExecutions[taskExecutionId]).toMatchObject({ status: 'running', currentAttemptId: attempt2, attemptIds: [attempt1, attempt2] });
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

  it('replays the first retry fence when a task has no prior attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-first-retry', 'task-1');
    const projection = replayDomainEvents([event({
      eventId: 'first-retry-queued',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskQueued',
      payload: {
        runId: 'run-first-retry',
        taskId: 'task-1',
        taskExecutionId,
        nextAttempt: 1,
      },
    })]);

    expect(projection.taskExecutions[taskExecutionId]).toMatchObject({
      status: 'queued',
      pendingAttempt: 1,
      attemptIds: [],
    });
  });

  it('replays duplicate pending retry fences idempotently', () => {
    const taskExecutionId = createTaskExecutionId('run-duplicate-retry', 'task-1');
    const base = {
      runId: 'run-duplicate-retry',
      taskId: 'task-1',
      taskExecutionId,
      nextAttempt: 1,
    };
    const projection = replayDomainEvents([
      event({ eventId: 'duplicate-retry-1', aggregateType: 'TaskExecution', aggregateId: taskExecutionId, eventType: 'TaskQueued', payload: base }),
      event({ eventId: 'duplicate-retry-2', sequence: 2, aggregateType: 'TaskExecution', aggregateId: taskExecutionId, aggregateVersion: 2, eventType: 'TaskQueued', payload: base }),
    ]);

    expect(projection.taskExecutions[taskExecutionId]).toMatchObject({ status: 'queued', pendingAttempt: 1, attemptIds: [] });
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
  it('rejects TaskCleaned without a preceding succeeded task', () => {
    const cleaned = event({
      eventId: 'evt-task-cleaned',
      aggregateId: 'task-cleaned',
      eventType: 'TaskCleaned',
      payload: { runId: 'run-cleaned', receiptId: 'cleanup-receipt-1' },
    });

    expect(() => replayDomainEvents([cleaned])).toThrow(/TaskCleaned|succeeded|provenance/i);
  });

  it('rejects TaskCleaned without a cleanup receipt even after a valid success', () => {
    const succeeded = event({
      eventId: 'cleanup-success',
      aggregateId: 'task-cleanup-receipt',
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-cleanup-receipt',
        evidenceIds: ['evidence-cleanup'],
        acceptanceId: 'acceptance-cleanup',
      },
    });
    const cleaned = event({
      eventId: 'cleanup-without-receipt',
      sequence: 2,
      aggregateId: 'task-cleanup-receipt',
      aggregateVersion: 2,
      eventType: 'TaskCleaned',
      payload: { runId: 'run-cleanup-receipt' },
    });

    expect(() => replayDomainEvents([succeeded, cleaned])).toThrow(/receipt|TaskCleaned/i);
  });
  it('rejects cleanupStatus on a non-TaskCleaned lifecycle event', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'fake-cleanup-status',
      eventType: 'TaskStarted',
      payload: {
        runId: 'run-fake-cleanup',
        cleanupStatus: 'cleaned',
      },
    })])).toThrow(/cleanupStatus|TaskCleaned/i);
  });
  it('rejects legacy TaskCleaned reused across different runs', () => {
    const succeeded = event({
      eventId: 'legacy-success-run-a',
      aggregateId: 'task-cross-run',
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-a',
        evidenceIds: ['evidence-cross-run'],
        acceptanceId: 'acceptance-cross-run',
      },
    });
    const cleaned = event({
      eventId: 'legacy-cleaned-run-b',
      sequence: 2,
      aggregateId: 'task-cross-run',
      aggregateVersion: 2,
      eventType: 'TaskCleaned',
      payload: { runId: 'run-b', receiptId: 'cleanup-cross-run' },
    });

    expect(() => replayDomainEvents([succeeded, cleaned])).toThrow(/runId|lineage|一致/i);
  });
  it('rejects unknown worktreeStatus in lifecycle payloads', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'unknown-worktree-status',
      aggregateType: 'TaskExecution',
      aggregateId: 'task-execution:run-worktree:task-1',
      eventType: 'TaskStarted',
      payload: {
        runId: 'run-worktree',
        taskId: 'task-1',
        taskExecutionId: 'task-execution:run-worktree:task-1',
        attempt: 1,
        attemptId: 'task-execution:run-worktree:task-1:attempt-1',
        worktreeStatus: 'mystery',
      },
    })])).toThrow(/worktreeStatus/i);
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
        aggregateVersion: 2,
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
        aggregateVersion: 3,
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
        aggregateVersion: 2,
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
        aggregateVersion: 3,
        eventType: 'TaskSucceeded',
        payload: {
          runId: 'run-b',
          taskId: 'task-1',
          taskExecutionId: secondExecutionId,
          attemptId: secondAttemptId,
          attempt: 1,
          evidenceIds: ['evidence-b'],
          acceptanceId: 'acceptance-b',
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
        aggregateVersion: 2,
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
        aggregateVersion: 3,
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
    expect(projection.taskExecutions[taskExecutionId].currentAttemptId).toBeUndefined();
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

  it('rejects aggregate version gaps during direct projection replay', () => {
    expect(() => replayDomainEvents([event({
      eventId: 'invalid-aggregate-version',
      aggregateType: 'Task',
      aggregateId: 'task-1',
      aggregateVersion: 2,
      eventType: 'TaskQueued',
      payload: { runId: 'run-1' },
    })])).toThrow(/aggregate|版本/);
  });

  it('rejects conflicting terminal events for the same attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-conflict', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'conflict-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-conflict', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const succeeded = event({
      eventId: 'conflict-succeeded',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-conflict',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId,
        evidenceIds: ['evidence-conflict'],
        acceptanceId: 'acceptance-conflict',
      },
    });
    const failed = event({
      eventId: 'conflict-failed',
      sequence: 3,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 3,
      eventType: 'TaskFailed',
      payload: { runId: 'run-conflict', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });

    expect(() => replayDomainEvents([started, succeeded, failed])).toThrow(/Attempt|attempt|状态/);
  });

  it('rejects a retry queue event that skips the next attempt number', () => {
    const taskExecutionId = createTaskExecutionId('run-jump', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'jump-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-jump', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const succeeded = event({
      eventId: 'jump-succeeded',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-jump',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId,
        evidenceIds: ['evidence-jump'],
        acceptanceId: 'acceptance-jump',
      },
    });
    const queued = event({
      eventId: 'jump-queued',
      sequence: 3,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 3,
      eventType: 'TaskQueued',
      payload: { runId: 'run-jump', taskId: 'task-1', taskExecutionId, nextAttempt: 3 },
    });

    expect(() => replayDomainEvents([started, succeeded, queued])).toThrow(/nextAttempt|attempt/);
  });

  it('rejects a repeated TaskQueued event after a terminal attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-reopen-queued', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'reopen-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-reopen-queued', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const succeeded = event({
      eventId: 'reopen-succeeded',
      sequence: 2,
      aggregateVersion: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-reopen-queued',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId,
        evidenceIds: ['evidence-reopen'],
        acceptanceId: 'acceptance-reopen',
      },
    });
    const queued = event({
      eventId: 'reopen-queued',
      sequence: 3,
      aggregateVersion: 3,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskQueued',
      payload: { runId: 'run-reopen-queued', taskId: 'task-1', taskExecutionId },
    });
    expect(() => replayDomainEvents([started, succeeded, queued])).toThrow(/queued|reopen|attempt/i);
  });

  it('rejects a new attempt while the previous attempt is still running', () => {
    const taskExecutionId = createTaskExecutionId('run-overlap', 'task-1');
    const firstAttemptId = createAttemptId(taskExecutionId, 1);
    const secondAttemptId = createAttemptId(taskExecutionId, 2);
    const first = event({
      eventId: 'overlap-first',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-overlap', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId: firstAttemptId },
    });
    const second = event({
      eventId: 'overlap-second',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskStarted',
      payload: { runId: 'run-overlap', taskId: 'task-1', taskExecutionId, attempt: 2, attemptId: secondAttemptId },
    });

    expect(() => replayDomainEvents([first, second])).toThrow(/running|Attempt|attempt/);
  });

  it('rejects a queued retry while the current attempt is still running', () => {
    const taskExecutionId = createTaskExecutionId('run-queued-overlap', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'queued-overlap-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-queued-overlap', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const queued = event({
      eventId: 'queued-overlap-retry',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskQueued',
      payload: { runId: 'run-queued-overlap', taskId: 'task-1', taskExecutionId, nextAttempt: 2 },
    });

    expect(() => replayDomainEvents([started, queued])).toThrow(/running|Attempt|attempt/);
  });

  it('rejects a late completion from the old attempt after a retry was queued', () => {
    const taskExecutionId = createTaskExecutionId('run-late-completion', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'late-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-late-completion', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const queued = event({
      eventId: 'late-retry',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskQueued',
      payload: { runId: 'run-late-completion', taskId: 'task-1', taskExecutionId, nextAttempt: 2 },
    });
    const late = event({
      eventId: 'late-succeeded',
      sequence: 3,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 3,
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-late-completion',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId,
        evidenceIds: ['evidence-late'],
        acceptanceId: 'acceptance-late',
      },
    });

    expect(() => replayDomainEvents([started, queued, late])).toThrow(/Attempt|attempt|running/);
  });

  it('requires the first started attempt to be attempt one', () => {
    const taskExecutionId = createTaskExecutionId('run-first-attempt', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 2);
    expect(() => replayDomainEvents([event({
      eventId: 'first-attempt-two',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-first-attempt', taskId: 'task-1', taskExecutionId, attempt: 2, attemptId },
    })])).toThrow(/首次|连续|Attempt|attempt/);
  });

  it('rejects reopening a terminal attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-terminal-reopen', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = event({
      eventId: 'terminal-started',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: 'run-terminal-reopen', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });
    const succeeded = event({
      eventId: 'terminal-succeeded',
      sequence: 2,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 2,
      eventType: 'TaskSucceeded',
      payload: {
        runId: 'run-terminal-reopen',
        taskId: 'task-1',
        taskExecutionId,
        attempt: 1,
        attemptId,
        evidenceIds: ['evidence-terminal'],
        acceptanceId: 'acceptance-terminal',
      },
    });
    const reopened = event({
      eventId: 'terminal-reopened',
      sequence: 3,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      aggregateVersion: 3,
      eventType: 'TaskStarted',
      payload: { runId: 'run-terminal-reopen', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    });

    expect(() => replayDomainEvents([started, succeeded, reopened])).toThrow(/终态|terminal|Attempt|attempt/);
  });

  it('rejects whitespace-padded lineage ids and unsafe attempt integers during replay', () => {
    const taskExecutionId = createTaskExecutionId('run-payload-canonical', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    expect(() => replayDomainEvents([event({
      eventId: 'padded-lineage',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: { runId: ' run-payload-canonical', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    })])).toThrow(/canonical|空白|lineage/);

    expect(() => replayDomainEvents([event({
      eventId: 'unsafe-attempt',
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType: 'TaskStarted',
      payload: {
        runId: 'run-payload-canonical',
        taskId: 'task-1',
        taskExecutionId,
        attempt: Number.MAX_SAFE_INTEGER + 1,
        attemptId: `${taskExecutionId}:attempt-${Number.MAX_SAFE_INTEGER + 1}`,
      },
    })])).toThrow(/整数|safe|attempt/);
  });

  it('accepts imported attempts only as synthetic system TaskExecution facts', () => {
    const taskExecutionId = createTaskExecutionId('run-import-provenance', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const base = {
      eventId: 'forged-import',
      aggregateId: taskExecutionId,
      eventType: 'TaskAttemptImported' as const,
      payload: { runId: 'run-import-provenance', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
    };
    expect(() => replayDomainEvents([event({ ...base, actor: 'runtime' })])).toThrow(/synthetic|system|迁移|import/);
    expect(() => replayDomainEvents([event({ ...base, aggregateType: 'Task', actor: 'system', synthetic: true, source: { objectId: 'migration', objectVersion: 1 } })])).toThrow(/aggregate|TaskExecution/);
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
