import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTestArtifactRoot } from '../dev/test-artifacts';
import type { DomainEvent, DomainProjection } from './contracts';
import {
  EventStoreError,
  EventStreamRepository,
  InMemoryEventStoreAdapter,
  NodeFileEventStoreAdapter,
  parseEventStream,
  projectionHash,
  serializeEventStream,
} from './eventStore';

const event = <TPayload>(
  partial: Partial<DomainEvent<TPayload>> & Pick<DomainEvent<TPayload>, 'eventType' | 'payload'>,
): DomainEvent<TPayload> => ({
  eventId: partial.eventId ?? `evt-${partial.sequence ?? 1}`,
  streamId: partial.streamId ?? 'project-1',
  sequence: partial.sequence ?? 1,
  aggregateType: partial.aggregateType ?? 'Run',
  aggregateId: partial.aggregateId ?? 'run-1',
  aggregateVersion: partial.aggregateVersion ?? 1,
  eventType: partial.eventType,
  schemaVersion: partial.schemaVersion ?? 1,
  payload: partial.payload,
  actor: partial.actor ?? 'runtime',
  occurredAt: partial.occurredAt ?? '2026-09-01T00:00:00.000Z',
});

describe('event stream parsing', () => {
  it('serializes canonical lines and parses them with integrity metadata', () => {
    const source = [
      event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } }),
      event({
        eventId: 'run-started',
        sequence: 2,
        aggregateVersion: 2,
        eventType: 'RunStarted',
        payload: { runId: 'run-1' },
      }),
    ];

    const parsed = parseEventStream(serializeEventStream(source));

    expect(parsed.status).toBe('ok');
    expect(parsed.events).toEqual(source);
    expect(parsed.lastSequence).toBe(2);
  });

  it('keeps the valid prefix and reports a malformed tail for repair', () => {
    const valid = serializeEventStream([
      event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } }),
    ]);
    const damaged = `${valid}{"eventId":"partial-tail"`;

    const parsed = parseEventStream(damaged);

    expect(parsed.status).toBe('needs-repair');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.corruption).toMatchObject({ line: 2 });
    expect(parsed.corruption?.tail).toContain('partial-tail');
  });

  it('rejects a checksum mismatch instead of silently accepting altered history', () => {
    const serialized = serializeEventStream([
      event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } }),
    ]).replace('RunCreated', 'RunTampered');

    const parsed = parseEventStream(serialized);

    expect(parsed.status).toBe('needs-repair');
    expect(parsed.corruption?.reason).toContain('checksum');
  });
});

describe('EventStreamRepository', () => {
  it('appends under a lock, enforces expected sequence, and makes duplicate retries no-op', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const created = event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } });
    const started = event({
      eventId: 'run-started',
      sequence: 2,
      aggregateVersion: 2,
      eventType: 'RunStarted',
      payload: { runId: 'run-1' },
    });

    await expect(repository.append(created, 1)).rejects.toMatchObject({ code: 'sequence-conflict' });
    expect((await repository.append(created, 0)).appended).toBe(true);
    expect((await repository.append(created, 0)).appended).toBe(false);
    expect((await repository.append(started, 1)).appended).toBe(true);
    await expect(repository.append(event({ sequence: 4, eventId: 'gap', eventType: 'RunSucceeded', payload: {} }), 2))
      .rejects.toMatchObject({ code: 'sequence-conflict' });
    expect(adapter.lockAcquisitions).toBe(5);
  });

  it('uses a valid matching snapshot and replays when the snapshot is stale or malformed', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const created = event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } });
    const started = event({
      eventId: 'run-started',
      sequence: 2,
      aggregateVersion: 2,
      eventType: 'RunStarted',
      payload: { runId: 'run-1' },
    });
    await repository.append(created, 0);
    await repository.append(started, 1);

    const first = await repository.loadProjection();
    expect(first).toMatchObject({ source: 'replay', projection: { lastSequence: 2 } });

    await repository.writeProjectionSnapshot(first.projection);
    const fromSnapshot = await repository.loadProjection();
    expect(fromSnapshot).toMatchObject({ source: 'snapshot', projection: { lastSequence: 2 } });

    await adapter.writeTextAtomic(
      repository.snapshotPath,
      JSON.stringify({ schemaVersion: 1, lastSequence: 999, projectionHash: 'bad', projection: {} }),
    );
    const afterStaleSnapshot = await repository.loadProjection();
    expect(afterStaleSnapshot).toMatchObject({ source: 'replay', projection: { lastSequence: 2 } });

    await adapter.writeTextAtomic(repository.eventsPath, `${serializeEventStream([created])}{bad-tail`);
    const damaged = await repository.loadProjection();
    expect(damaged.status).toBe('needs-repair');
    expect(damaged.projection).toBeNull();
  });

  it('replays legacy projection snapshots that lack execution indexes', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const runCreated = event({ eventId: 'legacy-run-created', aggregateId: 'run-legacy', eventType: 'RunCreated', payload: { runId: 'run-legacy' } });
    const taskStarted = event({
      eventId: 'legacy-task-started',
      sequence: 2,
      aggregateType: 'Task',
      aggregateId: 'task-legacy',
      eventType: 'TaskStarted',
      payload: { runId: 'run-legacy' },
    });
    await repository.append(runCreated, 0);
    await repository.append(taskStarted, 1);

    const current = await repository.loadProjection();

    expect(current.projection).not.toBeNull();
    const legacyProjection = JSON.parse(JSON.stringify(current.projection)) as Record<string, unknown>;
    delete legacyProjection.taskExecutions;
    delete legacyProjection.attempts;
    const legacy = legacyProjection as unknown as DomainProjection;
    await adapter.writeTextAtomic(
      repository.snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        lastSequence: 2,
        projectionHash: projectionHash(legacy),
        projection: legacy,
      }),
    );

    const reopened = await repository.loadProjection();
    expect(reopened.source).toBe('replay');
    expect(reopened.projection?.taskExecutions).toBeDefined();
    expect(reopened.projection?.attempts).toBeDefined();
    expect(Object.keys(reopened.projection?.attempts ?? {})).toHaveLength(1);
  });

  it('fails closed when appending to a stream that needs repair', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    await adapter.writeTextAtomic(repository.eventsPath, '{"eventId":"broken"');

    try {
      await repository.append(event({ eventType: 'RunCreated', payload: {} }), 0);
      throw new Error('expected append to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EventStoreError);
      expect(error).toMatchObject({ code: 'needs-repair' });
    }
  });

  it('appends a validated batch atomically and never leaves a partial batch', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const created = event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } });
    const started = event({
      eventId: 'run-started',
      sequence: 2,
      aggregateVersion: 2,
      eventType: 'RunStarted',
      payload: { runId: 'run-1' },
    });
    const succeeded = event({
      eventId: 'run-succeeded',
      sequence: 3,
      aggregateVersion: 3,
      eventType: 'RunSucceeded',
      payload: { runId: 'run-1' },
    });

    const result = await repository.appendBatch([created, started], 0);
    expect(result).toMatchObject({ appendedCount: 2, lastSequence: 2 });
    await expect(repository.appendBatch([
      succeeded,
      event({ eventId: 'gap', sequence: 5, aggregateVersion: 4, eventType: 'RunFailed', payload: {} }),
    ], 2)).rejects.toMatchObject({ code: 'sequence-conflict' });
    expect((await repository.readStream()).events).toEqual([created, started]);
    expect(adapter.lockAcquisitions).toBe(2);
  });

  it('persists the stream through the real filesystem adapter and releases its lock', async () => {
    await withTestArtifactRoot('event-store', async (root) => {
      const repository = new EventStreamRepository(new NodeFileEventStoreAdapter(root), root);
      const created = event({ eventId: 'run-created', eventType: 'RunCreated', payload: { runId: 'run-1' } });
      await repository.append(created, 0);

      const reopened = new EventStreamRepository(new NodeFileEventStoreAdapter(root), root);
      expect((await reopened.readStream()).events).toEqual([created]);
      expect((await reopened.loadProjection()).projection).toMatchObject({
        lastSequence: 1,
        runs: { 'run-1': { status: 'queued' } },
      });
    });
  });

  it('times out on a pre-existing lock without stealing or deleting it', async () => {
    await withTestArtifactRoot('stale-lock', async (root) => {
      const lockPath = join(root, '.slimemold', 'events', 'events.jsonl.lock');
      await mkdir(join(root, '.slimemold', 'events'), { recursive: true });
      await writeFile(lockPath, 'stale-owner', 'utf8');
      const adapter = new NodeFileEventStoreAdapter(root, { lockTimeoutMs: 25, lockPollMs: 5 });

      await expect(adapter.acquireLock(lockPath)).rejects.toMatchObject({ code: 'lock-timeout' });
      expect(await readFile(lockPath, 'utf8')).toBe('stale-owner');
    });
  });

  it('rejects lexical parent traversal before touching the filesystem', async () => {
    await withTestArtifactRoot('event-store-traversal', async (root) => {
      const adapter = new NodeFileEventStoreAdapter(root);
      const escaped = `${root}/.slimemold/events/../../../outside/events.jsonl`;

      await expect(adapter.readText(escaped)).rejects.toThrow(/事件存储路径逃逸/);
    });
  });

  it('rejects an event root replaced by a junction or symlink', async () => {
    await withTestArtifactRoot('event-store-reparse', async (root) => {
      const outside = `${root}-outside`;
      const linkedRoot = `${root}-linked`;
      await mkdir(outside, { recursive: true });
      await symlink(outside, linkedRoot, 'junction');
      try {
        const adapter = new NodeFileEventStoreAdapter(linkedRoot);
        await expect(adapter.readText(`${linkedRoot}/events.jsonl`)).rejects.toThrow(/事件存储路径逃逸/);
      } finally {
        await rm(linkedRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
