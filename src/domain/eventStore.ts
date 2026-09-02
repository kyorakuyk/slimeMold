import {
  appendDomainEvent,
  replayDomainEvents,
  type DomainEvent,
  type DomainProjection,
} from './contracts';

export const EVENT_STREAM_RELATIVE_PATH = '.slimemold/events/events.jsonl';
export const EVENT_SNAPSHOT_RELATIVE_PATH = '.slimemold/snapshots/project-state.json';
export const EVENT_LOCK_RELATIVE_PATH = '.slimemold/events/events.jsonl.lock';

export type EventStoreErrorCode =
  | 'sequence-conflict'
  | 'event-conflict'
  | 'needs-repair'
  | 'invalid-snapshot'
  | 'lock-timeout';

export class EventStoreError extends Error {
  constructor(
    public readonly code: EventStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventStoreError';
  }
}

export interface EventStoreLock {
  release(): Promise<void>;
}

/**
 * Persistence boundary for the domain store.
 *
 * A Tauri adapter must implement acquireLock with a process-safe lock and
 * writeTextAtomic with a temp-file + rename. Keeping both behind this boundary
 * lets the reducer/recovery code run in browser tests without pretending that
 * in-memory serialization is a cross-process safety guarantee.
 */
export interface EventStoreAdapter {
  readText(path: string): Promise<string | null>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  acquireLock(path: string): Promise<EventStoreLock>;
}

export interface NodeFileEventStoreAdapterOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
}

/**
 * Node/headless adapter. `open(..., 'wx')` provides cross-process exclusive
 * lock creation; stale locks fail closed after a bounded wait and are left for
 * an explicit repair action instead of being silently deleted.
 */
export class NodeFileEventStoreAdapter implements EventStoreAdapter {
  private readonly root: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;

  constructor(root: string, options: NodeFileEventStoreAdapterOptions = {}) {
    this.root = root.replace(/[\\/]+$/, '');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockPollMs = options.lockPollMs ?? 10;
  }

  private assertInsideRoot(path: string): void {
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const root = normalize(this.root);
    const candidate = normalize(path);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      throw new Error(`事件存储路径逃逸：${path}`);
    }
  }

  async readText(path: string): Promise<string | null> {
    this.assertInsideRoot(path);
    const fs = await import('node:fs/promises');
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.assertInsideRoot(path);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, text, 'utf8');
    try {
      await fs.rename(tmpPath, path);
    } catch (error) {
      try {
        await fs.unlink(path);
        await fs.rename(tmpPath, path);
      } catch {
        // Keep tmpPath for repair/retry; never fall back to truncate+write.
        throw error;
      }
    }
  }

  async acquireLock(path: string): Promise<EventStoreLock> {
    this.assertInsideRoot(path);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dirname(path), { recursive: true });
    const token = `event-lock:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

    while (!handle) {
      try {
        const candidate = await fs.open(path, 'wx');
        try {
          await candidate.writeFile(token, 'utf8');
          handle = candidate;
        } catch (error) {
          await candidate.close().catch(() => {});
          await fs.unlink(path).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new EventStoreError('lock-timeout', `事件存储锁等待超时：${path}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, this.lockPollMs));
      }
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const held = handle!;
        try {
          await held.close();
          // 文件仍存在时其它进程不能 create-new；关闭后从文件头读取 token，
          // 避免 FileHandle.readFile 从写入后的 EOF 开始读到空字符串。
          const current = await fs.readFile(path, 'utf8').catch(() => '');
          if (current === token) await fs.unlink(path).catch(() => {});
        } finally {
          handle = null;
        }
      },
    };
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? '.' : path.slice(0, index);
}

/** Browser/test adapter with FIFO locks; not a substitute for a disk lock. */
export class InMemoryEventStoreAdapter implements EventStoreAdapter {
  private readonly files = new Map<string, string>();
  private readonly lockTails = new Map<string, Promise<void>>();
  public lockAcquisitions = 0;

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async acquireLock(path: string): Promise<EventStoreLock> {
    this.lockAcquisitions += 1;
    const previous = this.lockTails.get(path) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.lockTails.set(path, tail);
    await previous;

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        releaseCurrent();
        if (this.lockTails.get(path) === tail) this.lockTails.delete(path);
      },
    };
  }
}

export interface EventStreamCorruption {
  line: number;
  raw: string;
  tail: string;
  reason: string;
}

export interface ParsedEventStream {
  status: 'empty' | 'ok' | 'needs-repair';
  events: DomainEvent[];
  lastSequence: number;
  corruption?: EventStreamCorruption;
}

type StoredDomainEvent = DomainEvent & {
  appendGeneration?: number;
  checksum?: string;
};

function eventBody(event: DomainEvent): Record<string, unknown> {
  const stored = event as StoredDomainEvent;
  const { appendGeneration: _appendGeneration, checksum: _checksum, ...body } = stored;
  return body;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Lightweight deterministic integrity checksum; cryptographic hashes belong in the host adapter. */
export function integrityChecksum(value: unknown): string {
  const text = typeof value === 'string' ? value : stableJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function eventChecksum(event: DomainEvent): string {
  return integrityChecksum(eventBody(event));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidActor(value: unknown): value is DomainEvent['actor'] {
  return (
    value === 'user' ||
    value === 'master' ||
    value === 'runtime' ||
    value === 'system' ||
    (typeof value === 'string' && value.startsWith('plugin:'))
  );
}

function decodeEvent(value: unknown): DomainEvent {
  if (!isRecord(value)) throw new Error('event line 必须是 JSON 对象');
  if (typeof value.eventId !== 'string' || !value.eventId.trim()) {
    throw new Error('eventId 无效');
  }
  if (typeof value.streamId !== 'string' || !value.streamId.trim()) {
    throw new Error('streamId 无效');
  }
  if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('sequence 无效');
  }
  if (typeof value.aggregateType !== 'string' || !value.aggregateType.trim()) {
    throw new Error('aggregateType 无效');
  }
  if (typeof value.aggregateId !== 'string' || !value.aggregateId.trim()) {
    throw new Error('aggregateId 无效');
  }
  if (
    typeof value.aggregateVersion !== 'number' ||
    !Number.isSafeInteger(value.aggregateVersion) ||
    value.aggregateVersion < 1
  ) {
    throw new Error('aggregateVersion 无效');
  }
  if (typeof value.eventType !== 'string' || !value.eventType.trim()) {
    throw new Error('eventType 无效');
  }
  if (typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion)) {
    throw new Error('schemaVersion 无效');
  }
  if (!('payload' in value)) throw new Error('payload 缺失');
  if (!isValidActor(value.actor)) throw new Error('actor 无效');
  if (typeof value.occurredAt !== 'string' || !value.occurredAt.trim()) {
    throw new Error('occurredAt 无效');
  }

  const stored = value as unknown as StoredDomainEvent;
  if (stored.appendGeneration !== undefined) {
    if (!Number.isSafeInteger(stored.appendGeneration) || stored.appendGeneration < 1) {
      throw new Error('appendGeneration 无效');
    }
  }
  if (stored.checksum !== undefined) {
    if (typeof stored.checksum !== 'string' || stored.checksum !== eventChecksum(stored)) {
      throw new Error('event checksum 校验失败');
    }
  }
  return eventBody(stored) as unknown as DomainEvent;
}

function equivalentEvents(left: DomainEvent, right: DomainEvent): boolean {
  return stableJson(eventBody(left)) === stableJson(eventBody(right));
}

function corruption(
  lines: string[],
  lineIndex: number,
  reason: unknown,
): EventStreamCorruption {
  return {
    line: lineIndex + 1,
    raw: lines[lineIndex] ?? '',
    tail: lines.slice(lineIndex).join('\n'),
    reason: reason instanceof Error ? reason.message : String(reason),
  };
}

/** Parse without dropping a damaged suffix; callers must surface needs-repair. */
export function parseEventStream(text: string | null | undefined): ParsedEventStream {
  if (!text || !text.trim()) return { status: 'empty', events: [], lastSequence: 0 };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const events: DomainEvent[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      const decoded = decodeEvent(JSON.parse(raw) as unknown);
      const existing = events.find((item) => item.eventId === decoded.eventId);
      if (existing) {
        if (!equivalentEvents(existing, decoded)) {
          throw new Error(`重复 eventId 内容不同：${decoded.eventId}`);
        }
        continue;
      }
      const next = appendDomainEvent(events, decoded);
      events.splice(0, events.length, ...next);
    } catch (error) {
      return {
        status: 'needs-repair',
        events,
        lastSequence: events.at(-1)?.sequence ?? 0,
        corruption: corruption(lines, index, error),
      };
    }
  }

  return {
    status: events.length ? 'ok' : 'empty',
    events,
    lastSequence: events.at(-1)?.sequence ?? 0,
  };
}

function storedEvent(event: DomainEvent, appendGeneration: number): StoredDomainEvent {
  const body = eventBody(event) as unknown as DomainEvent;
  return {
    ...body,
    appendGeneration,
    checksum: eventChecksum(body),
  };
}

export function serializeEventStream(events: readonly DomainEvent[]): string {
  if (events.length === 0) return '';
  return `${events.map((event, index) => JSON.stringify(storedEvent(event, index + 1))).join('\n')}\n`;
}

export interface ProjectionSnapshot {
  schemaVersion: 1;
  lastSequence: number;
  projectionHash: string;
  projection: DomainProjection;
}

export function projectionHash(projection: DomainProjection): string {
  return integrityChecksum(projection);
}

export function serializeProjectionSnapshot(projection: DomainProjection): string {
  const snapshot: ProjectionSnapshot = {
    schemaVersion: 1,
    lastSequence: projection.lastSequence,
    projectionHash: projectionHash(projection),
    projection,
  };
  return JSON.stringify(snapshot);
}

export function parseProjectionSnapshot(text: string | null | undefined): ProjectionSnapshot | null {
  if (!text || !text.trim()) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1) return null;
    if (
      typeof value.lastSequence !== 'number' ||
      !Number.isSafeInteger(value.lastSequence) ||
      value.lastSequence < 0 ||
      typeof value.projectionHash !== 'string' ||
      !isRecord(value.projection)
    ) {
      return null;
    }
    const projection = value.projection as unknown as DomainProjection;
    if (
      projection.lastSequence !== value.lastSequence ||
      !isRecord(projection.runs) ||
      !isRecord(projection.tasks) ||
      !isRecord(projection.taskExecutions) ||
      !isRecord(projection.attempts) ||
      projectionHash(projection) !== value.projectionHash
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      lastSequence: value.lastSequence,
      projectionHash: value.projectionHash,
      projection,
    };
  } catch {
    return null;
  }
}

export interface EventAppendResult {
  appended: boolean;
  event: DomainEvent;
  events: DomainEvent[];
  lastSequence: number;
}

export interface EventBatchAppendResult {
  appendedCount: number;
  events: DomainEvent[];
  lastSequence: number;
}

export interface ProjectionLoadResult {
  status: 'ok' | 'needs-repair';
  source: 'snapshot' | 'replay' | 'none';
  projection: DomainProjection | null;
  corruption?: EventStreamCorruption;
}

function joinPath(root: string, relative: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  return normalizedRoot ? `${normalizedRoot}/${relative}` : relative;
}

export class EventStreamRepository {
  public readonly eventsPath: string;
  public readonly snapshotPath: string;
  private readonly lockPath: string;

  constructor(
    private readonly adapter: EventStoreAdapter,
    root: string,
  ) {
    this.eventsPath = joinPath(root, EVENT_STREAM_RELATIVE_PATH);
    this.snapshotPath = joinPath(root, EVENT_SNAPSHOT_RELATIVE_PATH);
    this.lockPath = joinPath(root, EVENT_LOCK_RELATIVE_PATH);
  }

  async readStream(): Promise<ParsedEventStream> {
    return parseEventStream(await this.adapter.readText(this.eventsPath));
  }

  async appendBatch(
    incoming: readonly DomainEvent[],
    expectedLastSequence: number,
  ): Promise<EventBatchAppendResult> {
    const lock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseEventStream(await this.adapter.readText(this.eventsPath));
      if (parsed.status === 'needs-repair') {
        throw new EventStoreError(
          'needs-repair',
          `事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
        );
      }

      let events = parsed.events;
      let appendedCount = 0;
      for (const event of incoming) {
        const existing = events.find((item) => item.eventId === event.eventId);
        if (existing) {
          if (!equivalentEvents(existing, event)) {
            throw new EventStoreError('event-conflict', `eventId 内容不同：${event.eventId}`);
          }
          continue;
        }
        if (appendedCount === 0 && parsed.lastSequence !== expectedLastSequence) {
          throw new EventStoreError(
            'sequence-conflict',
            `事件流版本冲突：期望 lastSequence=${expectedLastSequence}，实际 ${parsed.lastSequence}`,
          );
        }
        try {
          events = appendDomainEvent(events, event);
        } catch (error) {
          throw new EventStoreError(
            'sequence-conflict',
            error instanceof Error ? error.message : String(error),
          );
        }
        appendedCount += 1;
      }

      if (appendedCount > 0) {
        await this.adapter.writeTextAtomic(this.eventsPath, serializeEventStream(events));
      }
      return {
        appendedCount,
        events,
        lastSequence: events.at(-1)?.sequence ?? 0,
      };
    } finally {
      await lock.release();
    }
  }

  async append(event: DomainEvent, expectedLastSequence: number): Promise<EventAppendResult> {
    const lock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseEventStream(await this.adapter.readText(this.eventsPath));
      if (parsed.status === 'needs-repair') {
        throw new EventStoreError(
          'needs-repair',
          `事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
        );
      }

      const existing = parsed.events.find((item) => item.eventId === event.eventId);
      if (existing) {
        if (!equivalentEvents(existing, event)) {
          throw new EventStoreError('event-conflict', `eventId 内容不同：${event.eventId}`);
        }
        return {
          appended: false,
          event: existing,
          events: parsed.events,
          lastSequence: parsed.lastSequence,
        };
      }

      if (parsed.lastSequence !== expectedLastSequence) {
        throw new EventStoreError(
          'sequence-conflict',
          `事件流版本冲突：期望 lastSequence=${expectedLastSequence}，实际 ${parsed.lastSequence}`,
        );
      }

      let events: DomainEvent[];
      try {
        events = appendDomainEvent(parsed.events, event);
      } catch (error) {
        throw new EventStoreError(
          'sequence-conflict',
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.adapter.writeTextAtomic(this.eventsPath, serializeEventStream(events));
      return {
        appended: true,
        event,
        events,
        lastSequence: event.sequence,
      };
    } finally {
      await lock.release();
    }
  }

  async loadProjection(): Promise<ProjectionLoadResult> {
    const lock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseEventStream(await this.adapter.readText(this.eventsPath));
      if (parsed.status === 'needs-repair') {
        return {
          status: 'needs-repair',
          source: 'none',
          projection: null,
          corruption: parsed.corruption,
        };
      }

      const snapshot = parseProjectionSnapshot(await this.adapter.readText(this.snapshotPath));
      if (snapshot && snapshot.lastSequence === parsed.lastSequence) {
        return { status: 'ok', source: 'snapshot', projection: snapshot.projection };
      }

      try {
        return {
          status: 'ok',
          source: 'replay',
          projection: replayDomainEvents(parsed.events),
        };
      } catch (error) {
        return {
          status: 'needs-repair',
          source: 'none',
          projection: null,
          corruption: {
            line: 0,
            raw: '',
            tail: '',
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } finally {
      await lock.release();
    }
  }

  async writeProjectionSnapshot(projection: DomainProjection | null): Promise<void> {
    if (!projection) throw new EventStoreError('invalid-snapshot', '不能保存空 projection');
    const lock = await this.adapter.acquireLock(this.lockPath);
    try {
      await this.adapter.writeTextAtomic(this.snapshotPath, serializeProjectionSnapshot(projection));
    } finally {
      await lock.release();
    }
  }
}
