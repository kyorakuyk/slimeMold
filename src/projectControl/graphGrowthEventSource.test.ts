import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import {
  EVENT_STREAM_RELATIVE_PATH,
  NodeFileEventStoreAdapter,
} from '../domain/eventStore';
import { withTestArtifactRoot } from '../dev/test-artifacts';
import { createGraphGrowthEventSource } from './graphGrowthEventSource';

function event(sequence: number): DomainEvent {
  return {
    eventId: `event-${sequence}`,
    streamId: 'project-1',
    sequence,
    aggregateType: 'Project',
    aggregateId: 'project-1',
    aggregateVersion: sequence,
    eventType: sequence === 1 ? 'ProjectCreated' : 'ProjectUpdated',
    schemaVersion: 1,
    payload: { projectId: 'project-1', revision: sequence },
    actor: 'user',
    occurredAt: `2026-10-20T03:00:0${sequence}.000Z`,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 800): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('event-source update timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe('graph-growth event source', () => {
  it('reads a project event file, observes appended events, and stops after unsubscribe', async () => {
    await withTestArtifactRoot('graph-growth-event-source', async (root) => {
      const eventsPath = join(root, EVENT_STREAM_RELATIVE_PATH);
      await mkdir(dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, `${JSON.stringify(event(1))}\n`, 'utf8');
      const source = createGraphGrowthEventSource({
        isTauri: true,
        projectRoot: root,
        adapter: new NodeFileEventStoreAdapter(root),
        pollIntervalMs: 20,
      });
      let resolveFirst!: (snapshot: Awaited<ReturnType<typeof source.read>>) => void;
      let resolveSecond!: (snapshot: Awaited<ReturnType<typeof source.read>>) => void;
      const first = new Promise<Awaited<ReturnType<typeof source.read>>>((resolve) => {
        resolveFirst = resolve;
      });
      const second = new Promise<Awaited<ReturnType<typeof source.read>>>((resolve) => {
        resolveSecond = resolve;
      });
      const received: string[][] = [];
      const unsubscribe = source.subscribe((snapshot) => {
        received.push(snapshot.events.map((item) => item.eventId));
        if (snapshot.events.length === 1) resolveFirst(snapshot);
        if (snapshot.events.length === 2) resolveSecond(snapshot);
      });

      try {
        await expect(withTimeout(first)).resolves.toMatchObject({
          status: 'ok',
          events: [event(1)],
          corruptLineCount: 0,
        });
        await appendFile(eventsPath, `${JSON.stringify(event(2))}\n`, 'utf8');
        await expect(withTimeout(second)).resolves.toMatchObject({
          status: 'ok',
          events: [event(1), event(2)],
          corruptLineCount: 0,
        });
        const receivedCount = received.length;
        unsubscribe();
        await appendFile(eventsPath, `${JSON.stringify(event(3))}\n`, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(received).toHaveLength(receivedCount);
      } finally {
        unsubscribe();
      }
    });
  });

  it('skips malformed lines, counts them, and continues with the next valid sequence', async () => {
    await withTestArtifactRoot('graph-growth-event-corruption', async (root) => {
      const eventsPath = join(root, EVENT_STREAM_RELATIVE_PATH);
      await mkdir(dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, [
        JSON.stringify(event(1)),
        '{not-json',
        JSON.stringify(event(2)),
        '',
      ].join('\n'), 'utf8');
      const source = createGraphGrowthEventSource({
        isTauri: true,
        projectRoot: root,
        adapter: new NodeFileEventStoreAdapter(root),
      });

      await expect(source.read()).resolves.toMatchObject({
        status: 'ok',
        events: [event(1), event(2)],
        corruptLineCount: 1,
      });
    });
  });

  it('returns an empty snapshot without reading for browser or missing-project mode', async () => {
    const readText = vi.fn(async () => null);
    const expected = { status: 'empty', events: [], corruptLineCount: 0 };

    const browserSource = createGraphGrowthEventSource({
      isTauri: false,
      projectRoot: 'C:/project',
      adapter: { readText },
    });
    const noProjectSource = createGraphGrowthEventSource({
      isTauri: true,
      projectRoot: null,
      adapter: { readText },
    });

    await expect(browserSource.read()).resolves.toEqual(expected);
    await expect(noProjectSource.read()).resolves.toEqual(expected);
    expect(readText).not.toHaveBeenCalled();
  });

  it('surfaces read failures instead of disguising them as an empty stream', async () => {
    const source = createGraphGrowthEventSource({
      isTauri: true,
      projectRoot: 'C:/project',
      adapter: { readText: async () => { throw new Error('permission denied'); } },
    });

    await expect(source.read()).resolves.toMatchObject({
      status: 'error',
      events: [],
      corruptLineCount: 0,
      error: 'permission denied',
    });
  });
});
