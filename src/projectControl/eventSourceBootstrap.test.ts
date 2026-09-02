import { beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import { EventStreamRepository, InMemoryEventStoreAdapter } from '../domain/eventStore';
import { createEmptyProjectControlSnapshot } from './persistence';
import { ensureProjectControlEventBaseline } from './eventSourceBootstrap';

let adapter: InMemoryEventStoreAdapter;
let repository: EventStreamRepository;

beforeEach(() => {
  adapter = new InMemoryEventStoreAdapter();
  repository = new EventStreamRepository(adapter, 'project-root');
});

function event(): DomainEvent {
  return {
    eventId: 'existing-event',
    streamId: 'project-1',
    sequence: 1,
    aggregateType: 'Project',
    aggregateId: 'project-1',
    aggregateVersion: 1,
    eventType: 'ProjectCreated',
    schemaVersion: 1,
    payload: { projectId: 'project-1' },
    actor: 'user',
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('project control event source bootstrap', () => {
  it('imports an empty legacy control snapshot as a synthetic baseline', async () => {
    const snapshot = createEmptyProjectControlSnapshot();
    const result = await ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.migrated).toBe(true);
    expect(result.stream.events[0]).toMatchObject({
      eventType: 'ProjectControlBaselineImported',
      synthetic: true,
    });
    await expect(repository.loadProjection()).resolves.toMatchObject({
      status: 'ok',
      source: 'snapshot',
    });
  });

  it('does not write a second baseline on a non-empty event stream', async () => {
    await repository.append(event(), 0);
    const result = await ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.migrated).toBe(false);
    expect(result.stream.events).toEqual([event()]);
  });

  it('fails closed when the existing stream needs repair', async () => {
    await adapter.writeTextAtomic(repository.eventsPath, '{broken');

    await expect(ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      now: '2026-09-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'needs-repair' });
  });
});
