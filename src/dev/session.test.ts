import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './node-run';
import { initDevSession, resetDevSession } from './session';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
}

describe('DevSession cleanup', () => {
  afterEach(() => {
    resetDevSession();
  });

  it('cleans a Worker worktree by its registered id when approval addresses its path', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return ok('base-1\n');
      return ok();
    });
    const session = initDevSession({
      baseRepoPath: '/repo',
      gitRunner: { git },
    });
    const info = await session.manager.create(
      'worker-id',
      '/repo-workers/run-1/task-1',
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

    await expect(session.confirmAndCleanup(info!.path)).resolves.toBe(true);
    expect(calls).toContainEqual(['worktree', 'remove', '--force', info!.path]);
    expect(session.manager.get(info!.id)?.status).toBe('cleaned');
  });

  it('rejects an acceptance that declares partial lineage provenance', () => {
    const session = initDevSession({ baseRepoPath: '/repo' });
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');

    expect(() => session.recordAcceptance({
      acceptanceId: 'acc-partial-lineage',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: '/repo-workers/run-1/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    })).toThrow(/runId|taskId|lineage/);
  });
});
