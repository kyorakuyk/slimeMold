import { describe, expect, it, beforeEach } from 'vitest';
import { EventStreamRepository, InMemoryEventStoreAdapter } from '../domain/eventStore';
import type { DomainEvent } from '../domain/contracts';
import {
  clearProjectEventBuffer,
  flushPendingProjectEvents,
  getPendingProjectEvents,
  recordProjectEvents,
} from './eventBuffer';

const event = (partial: Partial<DomainEvent> & Pick<DomainEvent, 'eventType' | 'payload'>): DomainEvent => ({
  eventId: partial.eventId ?? `evt-${partial.sequence ?? 1}`,
  streamId: partial.streamId ?? 'project-1',
  sequence: partial.sequence ?? 1,
  aggregateType: partial.aggregateType ?? 'Project',
  aggregateId: partial.aggregateId ?? 'project-1',
  aggregateVersion: partial.aggregateVersion ?? 1,
  eventType: partial.eventType,
  schemaVersion: partial.schemaVersion ?? 1,
  payload: partial.payload,
  actor: partial.actor ?? 'user',
  occurredAt: partial.occurredAt ?? '2026-09-01T00:00:00.000Z',
});

beforeEach(() => {
  clearProjectEventBuffer();
});

describe('project event buffer', () => {
  it('keeps pending events isolated by project and rebases sequence numbers', () => {
    recordProjectEvents('project-1', [
      event({ eventId: 'project-created', eventType: 'ProjectCreated', payload: {} }),
      event({ eventId: 'session-started', sequence: 2, eventType: 'SessionStarted', payload: {} }),
    ]);
    recordProjectEvents('project-1', [
      event({ eventId: 'issue-created', eventType: 'IssueCreated', payload: {} }),
    ]);
    recordProjectEvents('project-2', [
      event({ streamId: 'project-2', aggregateId: 'project-2', eventId: 'other', eventType: 'ProjectCreated', payload: {} }),
    ]);

    expect(getPendingProjectEvents('project-1').map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(getPendingProjectEvents('project-2').map((item) => item.sequence)).toEqual([1]);
  });

  it('flushes one project atomically and clears only that project after success', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const pending = [
      event({ eventId: 'project-created', eventType: 'ProjectCreated', payload: {} }),
      event({ eventId: 'session-started', sequence: 2, aggregateType: 'Session', aggregateId: 'session-1', aggregateVersion: 1, eventType: 'SessionStarted', payload: {} }),
    ];
    recordProjectEvents('project-1', pending);
    recordProjectEvents('project-2', [
      event({ streamId: 'project-2', aggregateId: 'project-2', eventId: 'other', eventType: 'ProjectCreated', payload: {} }),
    ]);

    await expect(flushPendingProjectEvents('project-1', repository)).resolves.toMatchObject({ count: 2 });
    expect(getPendingProjectEvents('project-1')).toEqual([]);
    expect(getPendingProjectEvents('project-2')).toHaveLength(1);
    expect((await repository.readStream()).events).toEqual(pending);
    await expect(repository.loadProjection()).resolves.toMatchObject({
      status: 'ok',
      source: 'snapshot',
      projection: { lastSequence: 2 },
    });
  });

  it('keeps pending events when the destination stream needs repair', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    recordProjectEvents('project-1', [event({ eventType: 'ProjectCreated', payload: {} })]);
    await adapter.writeTextAtomic(repository.eventsPath, '{broken-tail');

    await expect(flushPendingProjectEvents('project-1', repository)).rejects.toMatchObject({ code: 'needs-repair' });
    expect(getPendingProjectEvents('project-1')).toHaveLength(1);
  });

  it('rebases pending facts onto an already persisted stream without resetting versions', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const existing = event({ eventId: 'project-created', eventType: 'ProjectCreated', payload: {} });
    await repository.append(existing, 0);
    recordProjectEvents('project-1', [
      event({ eventId: 'session-started', aggregateType: 'Session', aggregateId: 'session-1', eventType: 'SessionStarted', payload: {} }),
    ]);

    await flushPendingProjectEvents('project-1', repository);

    expect((await repository.readStream()).events).toEqual([
      existing,
      expect.objectContaining({ eventId: 'session-started', sequence: 2, aggregateVersion: 1 }),
    ]);
    expect(getPendingProjectEvents('project-1')).toEqual([]);
  });

  it('repairs a missing projection snapshot when all pending facts are already present', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const existing = event({ eventId: 'project-created', eventType: 'ProjectCreated', payload: {} });
    await repository.append(existing, 0);
    recordProjectEvents('project-1', [existing]);

    await expect(flushPendingProjectEvents('project-1', repository)).resolves.toMatchObject({
      status: 'already-present',
    });
    await expect(repository.loadProjection()).resolves.toMatchObject({
      status: 'ok',
      source: 'snapshot',
      projection: { lastSequence: 1 },
    });
  });
});
