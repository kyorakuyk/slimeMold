import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './node-run';
import { initDevSession, resetDevSession } from './session';

const invoke = vi.hoisted(() => vi.fn(async (command: string) => {
  if (command === 'dev_create_dir' || command === 'dev_register_orphan_worktree') return undefined;
  throw new Error(`unexpected command: ${command}`);
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

const baseRevision = 'a'.repeat(40);
const branchRevision = 'b'.repeat(40);

describe('Tauri branch-only failed worktree allocation', () => {
  afterEach(() => {
    resetDevSession();
    invoke.mockClear();
  });

  it('registers verified branch-only lineage with the native host', async () => {
    let addFinished = false;
    const git = vi.fn(async (args: string[]): Promise<CommandResult> => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return result(0, `${baseRevision}\n`);
      if (args[0] === 'show-ref') return addFinished ? result(0) : result(1);
      if (args[0] === 'worktree' && args[1] === 'add') {
        addFinished = true;
        return result(128, '', 'required smudge filter failed after branch creation');
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/heads/'))) {
        return result(0, `${branchRevision}\n`);
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return result(0, 'worktree C:/repo\nHEAD base\nbranch refs/heads/main\n');
      }
      return result(0);
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: 'C:/repo',
      gitRunner: { git },
    });

    await expect(session.manager.create(
      'worker-partial',
      'C:/repo-workers/task-partial',
      { branch: 'worker/task-partial' },
    )).resolves.toBeNull();

    expect(session.manager.get('worker-partial')).toMatchObject({
      path: 'C:/repo-workers/task-partial',
      branch: 'worker/task-partial',
      baseRevision,
      branchRevision,
      status: 'orphaned',
    });
    expect(invoke).toHaveBeenCalledWith('dev_register_orphan_worktree', {
      path: 'C:/repo-workers/task-partial',
      branch: 'worker/task-partial',
      branchRevision,
      generation: 1,
    });
  });
});
