import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { auditWorkerRunConsistency } from './workerRunConsistency';

const run: WorkerRunQueueState = {
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
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
      cleanupStatus: 'cleaned',
      cleanupReceiptId: 'cleanup-receipt-1',
      updatedAt: '2026-09-01T00:01:00.000Z',
    },
  },
};

function event(partial: Partial<DomainEvent> & Pick<DomainEvent, 'eventType' | 'aggregateType' | 'aggregateId' | 'payload'>): DomainEvent {
  return {
    eventId: partial.eventId ?? `event-${partial.sequence ?? 1}`,
    streamId: partial.streamId ?? 'project-1',
    sequence: partial.sequence ?? 1,
    aggregateType: partial.aggregateType,
    aggregateId: partial.aggregateId,
    aggregateVersion: partial.aggregateVersion ?? 1,
    eventType: partial.eventType,
    schemaVersion: 1,
    payload: partial.payload,
    actor: 'runtime',
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

const events: DomainEvent[] = [
  event({ eventId: 'run-queued', aggregateType: 'Run', aggregateId: 'run-1', eventType: 'RunQueued', payload: { runId: 'run-1' } }),
  event({ eventId: 'task-queued', sequence: 2, aggregateType: 'Task', aggregateId: 'task-1', eventType: 'TaskQueued', payload: { runId: 'run-1' } }),
  event({ eventId: 'run-started', sequence: 3, aggregateType: 'Run', aggregateId: 'run-1', eventType: 'RunStarted', payload: { runId: 'run-1' } }),
  event({ eventId: 'task-started', sequence: 4, aggregateType: 'Task', aggregateId: 'task-1', eventType: 'TaskStarted', payload: { runId: 'run-1' } }),
  event({
    eventId: 'task-succeeded',
    sequence: 5,
    aggregateType: 'Task',
    aggregateId: 'task-1',
    eventType: 'TaskSucceeded',
    payload: { runId: 'run-1', evidenceIds: ['evidence-1'], acceptanceId: 'acceptance-1' },
  }),
  event({ eventId: 'task-cleaned', sequence: 6, aggregateType: 'Task', aggregateId: 'task-1', eventType: 'TaskCleaned', payload: { runId: 'run-1', receiptId: 'cleanup-receipt-1' } }),
  event({ eventId: 'run-succeeded', sequence: 7, aggregateType: 'Run', aggregateId: 'run-1', eventType: 'RunSucceeded', payload: { runId: 'run-1' } }),
];

describe('worker run consistency audit', () => {
  it('accepts a ProjectFile worker registry that matches replayed facts', () => {
    expect(auditWorkerRunConsistency({ projectId: 'project-1', runs: [run], events })).toMatchObject({
      ok: true,
      issues: [],
      projection: { runs: { 'run-1': { status: 'succeeded' } } },
    });
  });

  it('reports persisted run and task status drift instead of choosing a side silently', () => {
    const drifted = {
      ...run,
      status: 'failed' as const,
      tasks: { 'task-1': { ...run.tasks['task-1'], status: 'failed' as const } },
    };
    const result = auditWorkerRunConsistency({ projectId: 'project-1', runs: [drifted], events });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['run-status-drift', 'task-status-drift']));
  });

  it('reports a persisted run with no durable Run fact', () => {
    const result = auditWorkerRunConsistency({ projectId: 'project-1', runs: [run], events: [] });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-run-event', runId: 'run-1' }),
    ]));
  });

  it('fails closed when the event stream cannot be replayed', () => {
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events: [
        events[0],
        { ...events[1], sequence: 4 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'invalid-event-stream' });
  });
});
