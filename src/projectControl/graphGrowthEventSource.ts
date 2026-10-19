import { appendDomainEvent, type DomainEvent } from '../domain/contracts';
import {
  decodeEventRecord,
  EVENT_STREAM_RELATIVE_PATH,
  type EventStoreAdapter,
} from '../domain/eventStore';

export interface GraphGrowthEventSourceSnapshot {
  status: 'empty' | 'ok' | 'error';
  events: readonly DomainEvent[];
  corruptLineCount: number;
  error?: string;
}

export interface GraphGrowthEventSourceOptions {
  isTauri: boolean;
  projectRoot: string | null;
  adapter?: Pick<EventStoreAdapter, 'readText'>;
  pollIntervalMs?: number;
}

export interface GraphGrowthEventSource {
  read(): Promise<GraphGrowthEventSourceSnapshot>;
  subscribe(listener: (snapshot: GraphGrowthEventSourceSnapshot) => void): () => void;
}

const EMPTY_SNAPSHOT: GraphGrowthEventSourceSnapshot = {
  status: 'empty',
  events: [],
  corruptLineCount: 0,
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export function parseGraphGrowthEventText(text: string | null | undefined): GraphGrowthEventSourceSnapshot {
  if (!text || !text.trim()) return EMPTY_SNAPSHOT;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const events: DomainEvent[] = [];
  let corruptLineCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const decoded = decodeEventRecord(JSON.parse(line) as unknown);
      events.splice(0, events.length, ...appendDomainEvent(events, decoded));
    } catch {
      corruptLineCount += 1;
    }
  }

  return {
    status: events.length > 0 ? 'ok' : 'empty',
    events,
    corruptLineCount,
  };
}

function projectEventFilePath(projectRoot: string): string {
  const normalized = projectRoot.replace(/\\/g, '/');
  const root = normalized.replace(/\/+$/, '');
  if (!root) return normalized.startsWith('/') ? `/${EVENT_STREAM_RELATIVE_PATH}` : EVENT_STREAM_RELATIVE_PATH;
  return `${root}/${EVENT_STREAM_RELATIVE_PATH}`;
}

function readErrorSnapshot(error: unknown): GraphGrowthEventSourceSnapshot {
  return {
    status: 'error',
    events: [],
    corruptLineCount: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createGraphGrowthEventSource(
  options: GraphGrowthEventSourceOptions,
): GraphGrowthEventSource {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('graph-growth event-source poll interval 必须是正安全整数');
  }
  const projectRoot = options.projectRoot;
  const hasProject = Boolean(projectRoot && projectRoot.trim());
  const canRead = options.isTauri && hasProject;

  const read = async (): Promise<GraphGrowthEventSourceSnapshot> => {
    if (!canRead) return EMPTY_SNAPSHOT;
    if (!options.adapter) return readErrorSnapshot(new Error('Tauri event-source adapter is missing'));
    try {
      const text = await options.adapter.readText(projectEventFilePath(projectRoot!));
      return parseGraphGrowthEventText(text);
    } catch (error) {
      return readErrorSnapshot(error);
    }
  };

  return {
    read,
    subscribe(listener) {
      let active = true;
      let reading = false;
      let lastSnapshotKey: string | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;

      const publish = async (): Promise<void> => {
        if (!active || reading) return;
        reading = true;
        try {
          const snapshot = await read();
          if (!active) return;
          const key = JSON.stringify(snapshot);
          if (key !== lastSnapshotKey) {
            lastSnapshotKey = key;
            listener(snapshot);
          }
        } finally {
          reading = false;
        }
      };

      void publish();
      if (canRead) timer = globalThis.setInterval(() => { void publish(); }, pollIntervalMs);
      return () => {
        if (!active) return;
        active = false;
        if (timer !== undefined) globalThis.clearInterval(timer);
      };
    },
  };
}
