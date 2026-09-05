import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './node-run';
import { initDevSession, resetDevSession } from './session';

const hostState = vi.hoisted(() => ({ rejectUnregister: false }));
const invoke = vi.hoisted(() => vi.fn(async (command: string, _args?: unknown) => {
  if (command === 'dev_register_worktree') return undefined;
  if (command === 'dev_unregister_worktree' && hostState.rejectUnregister) {
    throw new Error('transient unregister failure');
  }
  if (command === 'dev_unregister_worktree') return undefined;
  throw new Error(`unexpected command: ${command}`);
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
}

describe('DevSession Tauri orphan cleanup', () => {
  afterEach(() => {
    resetDevSession();
    hostState.rejectUnregister = false;
    invoke.mockClear();
  });

  it('keeps Rust registration while retrying an orphaned branch cleanup', async () => {
    let branchCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('base-1\n');
      if (args[0] === 'worktree' && args[1] === 'remove') return ok();
      if (args[0] === 'branch') {
        branchCalls += 1;
        if (branchCalls === 1) {
          return { exitCode: 1, stdout: '', stderr: 'temporary branch failure', durationMs: 1 };
        }
        if (invoke.mock.calls.some(([command]) => command === 'dev_unregister_worktree')) {
          return { exitCode: 1, stdout: '', stderr: 'Rust registration was released too early', durationMs: 1 };
        }
        return ok();
      }
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
      gitRunner: { git },
    });
    const info = await session.manager.create(
      'worker-id',
      '/repo-workers/task-1',
      { branch: 'worker/task-1' },
    );
    expect(info).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith('dev_register_worktree', {
      path: info!.path,
      generation: 1,
    });

    await expect(session.manager.cleanup(info!.id, { confirm: true })).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('dev_unregister_worktree', expect.anything());
    expect(session.manager.get(info!.id)?.status).toBe('orphaned');
    await expect(session.manager.cleanup(info!.id, { confirm: true })).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('dev_unregister_worktree', {
      path: info!.path,
      generation: 1,
    });
  });

  it('keeps cleanup retryable when Rust unregister fails after Git cleanup', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('base-1\\n');
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
      gitRunner: { git },
    });
    const info = await session.manager.create(
      'worker-id',
      '/repo-workers/task-1',
      { branch: 'worker/task-1' },
    );
    expect(info).not.toBeNull();

    hostState.rejectUnregister = true;
    await expect(session.manager.cleanup(info!.id, { confirm: true })).resolves.toBe(false);
    expect(session.manager.get(info!.id)?.status).toBe('registration-pending');

    hostState.rejectUnregister = false;
    await expect(session.manager.cleanup(info!.id, { confirm: true })).resolves.toBe(true);
    expect(session.manager.get(info!.id)?.status).toBe('cleaned');
  });
});