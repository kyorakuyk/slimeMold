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
