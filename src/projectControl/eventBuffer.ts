import {
  appendDomainEvent,
  type DomainEvent,
} from '../domain/contracts';
import {
  EventStoreError,
  type EventStreamRepository,
} from '../domain/eventStore';
import { replayDomainEvents } from '../domain/contracts';

const pendingByProject = new Map<string, DomainEvent[]>();
const flushTails = new Map<string, Promise<void>>();

type PersistedEvent = DomainEvent & {
  appendGeneration?: number;
  checksum?: string;
};

type EventWithoutPosition = Omit<
  PersistedEvent,
  'sequence' | 'aggregateVersion' | 'appendGeneration' | 'checksum' | 'occurredAt'
>;

function requiredProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) throw new Error('项目 id 不能为空');
  return normalized;
}

function withoutPosition(event: DomainEvent): EventWithoutPosition {
  const {
    sequence: _sequence,
    aggregateVersion: _aggregateVersion,
    appendGeneration: _appendGeneration,
    checksum: _checksum,
    occurredAt: _occurredAt,
    ...rest
  } = event as PersistedEvent;
  return rest;
}

function equivalentIgnoringPosition(left: DomainEvent, right: DomainEvent): boolean {
  return JSON.stringify(withoutPosition(left)) === JSON.stringify(withoutPosition(right));
}

function latestAggregateVersion(events: readonly DomainEvent[], event: DomainEvent): number {
  return events
    .filter((item) => item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId)
    .reduce((version, item) => Math.max(version, item.aggregateVersion), 0);
}

export function clearProjectEventBuffer(projectId?: string): void {
  if (projectId === undefined) {
    pendingByProject.clear();
    return;
  }
  pendingByProject.delete(requiredProjectId(projectId));
}

export function getPendingProjectEvents(projectId: string): DomainEvent[] {
  return [...(pendingByProject.get(requiredProjectId(projectId)) ?? [])];
}

/** Add command facts to the project-local pending buffer without doing I/O. */
export function recordProjectEvents(projectId: string, incoming: readonly DomainEvent[]): void {
  const normalizedProjectId = requiredProjectId(projectId);
  const events = pendingByProject.get(normalizedProjectId) ?? [];
  for (const event of incoming) {
    if (event.streamId !== normalizedProjectId) {
      throw new EventStoreError(
        'event-conflict',
        `事件 streamId 与缓冲项目不一致：${event.streamId} ≠ ${normalizedProjectId}`,
      );
    }
    const existing = events.find((item) => item.eventId === event.eventId);
    if (existing) {
      if (!equivalentIgnoringPosition(existing, event)) {
        throw new EventStoreError('event-conflict', `pending eventId 内容不同：${event.eventId}`);
      }
      continue;
    }
    const candidate: DomainEvent = {
      ...event,
      sequence: events.at(-1)?.sequence ? events.at(-1)!.sequence + 1 : 1,
      aggregateVersion: latestAggregateVersion(events, event) + 1,
    };
    events.splice(0, events.length, ...appendDomainEvent(events, candidate));
  }
  if (events.length > 0) pendingByProject.set(normalizedProjectId, events);
}

export interface FlushPendingProjectEventsResult {
  status: 'empty' | 'flushed' | 'already-present';
  count: number;
}

/**
 * Persist pending facts after a project receives a disk root. The buffer is
 * cleared only after appendBatch succeeds; repair/conflict errors are visible
 * to the caller and leave the facts available for retry.
 */
export async function flushPendingProjectEvents(
  projectId: string,
  repository: EventStreamRepository,
): Promise<FlushPendingProjectEventsResult> {
  const normalizedProjectId = requiredProjectId(projectId);
  const previous = flushTails.get(normalizedProjectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  flushTails.set(normalizedProjectId, queued);
  await previous.catch(() => {});
  try {
    const pending = getPendingProjectEvents(normalizedProjectId);
    if (pending.length === 0) return { status: 'empty', count: 0 };

    const parsed = await repository.readStream();
    if (parsed.status === 'needs-repair') {
      throw new EventStoreError(
        'needs-repair',
        `事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
      );
    }

    let working = parsed.events;
    const newEvents: DomainEvent[] = [];
    for (const pendingEvent of pending) {
      if (pendingEvent.streamId !== normalizedProjectId) {
        throw new EventStoreError('event-conflict', `事件 streamId 与项目不一致：${pendingEvent.streamId}`);
      }
      const existing = working.find((event) => event.eventId === pendingEvent.eventId);
      if (existing) {
        if (!equivalentIgnoringPosition(existing, pendingEvent)) {
          throw new EventStoreError('event-conflict', `已落盘 eventId 内容不同：${pendingEvent.eventId}`);
        }
        continue;
      }
      const candidate: DomainEvent = {
        ...pendingEvent,
        sequence: (working.at(-1)?.sequence ?? 0) + 1,
        aggregateVersion: latestAggregateVersion(working, pendingEvent) + 1,
      };
      working = appendDomainEvent(working, candidate);
      newEvents.push(candidate);
    }

    if (newEvents.length === 0) {
      await repository.writeProjectionSnapshot(replayDomainEvents(working));
      clearProjectEventBuffer(normalizedProjectId);
      return { status: 'already-present', count: pending.length };
    }

    const appended = await repository.appendBatch(newEvents, parsed.lastSequence);
    // Keep a verifiable replay checkpoint beside the append-only facts. If this
    // second write fails, pending events remain available for an idempotent retry.
    await repository.writeProjectionSnapshot(replayDomainEvents(appended.events));
    clearProjectEventBuffer(normalizedProjectId);
    return { status: 'flushed', count: newEvents.length };
  } finally {
    release();
    if (flushTails.get(normalizedProjectId) === queued) flushTails.delete(normalizedProjectId);
  }
}
