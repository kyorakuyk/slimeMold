import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './node-run';
import { initDevSession, resetDevSession } from './session';

const hostState = vi.hoisted(() => ({ rejectRegister: false, rejectUnregister: false }));
const invoke = vi.hoisted(() => vi.fn(async (command: string, _args?: unknown) => {
  if (command === 'dev_register_worktree' && hostState.rejectRegister) {
    throw new Error('transient register failure');
  }
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

const TIP_OID = 'b'.repeat(40);

describe('DevSession Tauri orphan cleanup', () => {
  afterEach(() => {
    resetDevSession();
    hostState.rejectRegister = false;
    hostState.rejectUnregister = false;
    invoke.mockClear();
  });

  it('keeps Rust registration while retrying an orphaned branch cleanup', async () => {
    let branchCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'remove') return ok();
      if (args[0] === 'update-ref') {
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
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
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

  it('retries registration-pending cleanup through confirmAndCleanup without recomputing a deleted worktree', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
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
    session.computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const acceptanceId = session.nextAcceptanceId();
    session.recordAcceptance({
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: info!.path,
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    });
    session.approveCleanup(info!.path, {
      baseRevision: info!.baseRevision,
      stateSignature: 'sig-1',
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
    });

    hostState.rejectUnregister = true;
    await expect(session.confirmAndCleanup(info!.path)).resolves.toBe(false);
    expect(session.manager.get(info!.id)?.status).toBe('registration-pending');

    hostState.rejectUnregister = false;
    await expect(session.confirmAndCleanup(info!.path)).resolves.toBe(true);
    expect(session.manager.get(info!.id)?.status).toBe('cleaned');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.filter(([command]) => command === 'dev_unregister_worktree')).toHaveLength(2);
  });

  it('does not unregister a worktree whose initial Rust registration never succeeded', async () => {
    let removeCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls += 1;
        if (removeCalls === 1) {
          return { exitCode: 1, stdout: '', stderr: 'temporary remove failure', durationMs: 1 };
        }
      }
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
      gitRunner: { git },
    });
    hostState.rejectRegister = true;
    await expect(session.manager.create(
      'worker-id',
      '/repo-workers/task-1',
      { branch: 'worker/task-1' },
    )).rejects.toThrow('transient register failure');
    expect(session.manager.get('worker-id')?.status).toBe('created');

    hostState.rejectRegister = false;
    await expect(session.manager.cleanup('worker-id', { confirm: true })).resolves.toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === 'dev_unregister_worktree')).toHaveLength(0);
    expect(session.manager.get('worker-id')).toBeUndefined();
  });

  it('restores an orphaned branch lineage without registering a deleted worktree', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
      gitRunner: { git },
    });
    const info = {
      id: 'orphan-worker',
      path: '/repo-workers/orphan-worker',
      branch: 'worker/orphan-worker',
      baseRevision: 'base-1',
      branchRevision: TIP_OID,
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'orphaned' as const,
    };

    await expect(session.manager.restore(info)).resolves.toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('dev_register_worktree', expect.anything());
    await expect(session.manager.cleanup(info.id, { confirm: true })).resolves.toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('dev_unregister_worktree', expect.anything());
  });
});