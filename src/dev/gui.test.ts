import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeDefinition } from '../types';
import { getNodeDef, useRegistryStore } from '../store/registryStore';
import { ensureGuiDevSession, getDevGuiError, registerGuiDevDefs, teardownGuiDevSession } from './gui';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<string | number> => ''),
}));

vi.mock('../platform/env', async () => {
  const actual = await vi.importActual<typeof import('../platform/env')>('../platform/env');
  return { ...actual, isTauri: true };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/core.js', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {}),
  readTextFile: vi.fn(async () => ''),
}));

const devDef = {
  typeId: 'dev.worktree.create',
} as NodeDefinition;

describe('GUI DevSession registry bridge', () => {
  beforeEach(() => {
    useRegistryStore.setState({ defs: {} });
    invoke.mockReset();
    invoke.mockImplementation(async () => '');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
  });

  afterEach(async () => {
    await teardownGuiDevSession();
  });

  it('registers session defs even when the session already exists', () => {
    expect(getNodeDef(devDef.typeId)).toBeUndefined();

    registerGuiDevDefs([devDef]);

    expect(getNodeDef(devDef.typeId)).toBe(devDef);
  });

  it('tears down a stale project session before initializing another project', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'dev_init_session') return 1;
      return '';
    });

    const first = await ensureGuiDevSession('C:/repo-one');
    const second = await ensureGuiDevSession('C:/repo-two');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith('dev_clear_session', { generation: 1 });
    expect(invoke.mock.calls.filter(([command]) => command === 'dev_init_session')).toHaveLength(2);
  });

  it('single-flights concurrent initialization for the same project', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let initCalls = 0;
    invoke.mockImplementation(async (command: string, _args?: unknown) => {
      if (command === 'dev_init_session') {
        initCalls += 1;
        await gate;
        return 17;
      }
      return '';
    });

    const first = ensureGuiDevSession('/repo');
    await Promise.resolve();
    const second = ensureGuiDevSession('/repo');
    release();

    const [firstSession, secondSession] = await Promise.all([first, second]);
    expect(initCalls).toBe(1);
    expect(firstSession).not.toBeNull();
    expect(secondSession).toBe(firstSession);
  });

  it('keeps the initialization reason observable while remaining unavailable', async () => {
    invoke.mockImplementation(async (command: string, _args?: unknown) => {
      if (command === 'dev_init_session') throw new Error('Git top-level probe 失败');
      return '';
    });

    expect(await ensureGuiDevSession('C:/repo')).toBeNull();
    expect(getDevGuiError()).toBe('Git top-level probe 失败');
  });
});
