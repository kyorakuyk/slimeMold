import { describe, expect, it } from 'vitest';
import {
  createTauriEventStoreAdapter,
  type TauriEventStoreDeps,
} from './tauriEventStore';

function fakeDeps(): TauriEventStoreDeps & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  return {
    files,
    calls,
    invoke: async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      calls.push(`${command}:${JSON.stringify(args)}`);
      if (command === 'event_lock_acquire') return 'lock-token-1' as unknown as T;
      return undefined as unknown as T;
    },
    exists: async (path) => files.has(path),
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing: ${path}`);
      return value;
    },
    mkdir: async () => {},
    writeTextFile: async (path, text) => {
      calls.push(`write:${path}`);
      files.set(path, text);
    },
    rename: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing: ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    remove: async (path) => {
      calls.push(`remove:${path}`);
      files.delete(path);
    },
  };
}

describe('Tauri event store adapter', () => {
  it('uses grant, host lock, and temp-file rename for project writes', async () => {
    const deps = fakeDeps();
    const adapter = createTauriEventStoreAdapter('D:/repo', deps);
    const path = 'D:/repo/.slimemold/events/events.jsonl';

    await adapter.writeTextAtomic(path, 'event-line');
    const lock = await adapter.acquireLock('D:/repo/.slimemold/events/events.jsonl.lock');
    await lock.release();

    expect(deps.files.get(path)).toBe('event-line');
    expect(deps.calls.some((call) => call.startsWith('grant_project_access:'))).toBe(true);
    expect(deps.calls.some((call) => call.startsWith('event_lock_acquire:'))).toBe(true);
    expect(deps.calls.some((call) => call.startsWith('event_lock_release:'))).toBe(true);
    expect(deps.calls.some((call) => call.includes('.tmp'))).toBe(true);
  });

  it('supports a second project-local lock through the host', async () => {
    const deps = fakeDeps();
    const adapter = createTauriEventStoreAdapter('D:/repo', deps);
    const lock = await adapter.acquireLock('D:/repo/.slimemold/runs/side-effects.json.lock');

    await lock.release();

    expect(
      deps.calls.some(
        (call) =>
          call.includes('event_lock_acquire:') &&
          call.includes('"relativePath":".slimemold/runs/side-effects.json.lock"'),
      ),
    ).toBe(true);
    expect(
      deps.calls.some(
        (call) =>
          call.includes('event_lock_release:') &&
          call.includes('"relativePath":".slimemold/runs/side-effects.json.lock"'),
      ),
    ).toBe(true);
  });

  it('fails closed for paths outside the adapter root', async () => {
    const adapter = createTauriEventStoreAdapter('D:/repo', fakeDeps());
    await expect(adapter.readText('D:/other/.slimemold/events/events.jsonl')).rejects.toThrow(/逃逸/);
  });
});
