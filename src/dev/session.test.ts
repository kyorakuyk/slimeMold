import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './node-run';
import { createHostAcceptanceStoreWithFs, initDevSession, resetDevSession } from './session';
import type { AcceptanceRecord, AcceptancePersistence } from './session';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { cleanupBindingFingerprint } from '../projectControl/workerCleanup';
import type { WorkerCleanupProposalReady } from '../projectControl/workerCleanup';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('register rejected');
  }),
}));

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
}

const TIP_OID = 'b'.repeat(40);

function trustedProposal(session: ReturnType<typeof initDevSession>, path: string): WorkerCleanupProposalReady {
  return {
    status: 'ready',
    ...session.getCleanupApproval(path),
  } as WorkerCleanupProposalReady;
}

describe('DevSession cleanup', () => {
  afterEach(() => {
    resetDevSession();
  });

  it('cleans a Worker worktree by its registered id when approval addresses its path', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const session = initDevSession({
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
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreePath: info!.path,
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    });
    session.approveCleanup(info!.path, {
      worktreeId: info!.id,
      branch: info!.branch,
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      branchRevision: TIP_OID,
      branchRevisionRequired: true,
      baseRevision: info!.baseRevision,
      stateSignature: 'sig-1',
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      attempt: 1,
      taskStatus: 'succeeded',
      cleanupStatus: 'active',
    });

    await expect(session.confirmAndCleanup(info!.path)).resolves.toBe(false);
    expect(session.manager.get(info!.id)?.status).toBe('created');
    const fingerprint = cleanupBindingFingerprint(session.getCleanupApproval(info!.path)!);
    session.registerTrustedCleanupBinding(trustedProposal(session, info!.path));
    await expect(session.confirmAndCleanup(info!.path, undefined, fingerprint)).resolves.toBe(true);
    expect(calls).toContainEqual(['worktree', 'remove', '--force', info!.path]);
    expect(session.manager.get(info!.id)?.status).toBe('cleaned');
  });

  it('rejects an approval when the same path is reused by a different worktree identity', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const session = initDevSession({ baseRepoPath: '/repo', gitRunner: { git } });
    const original = await session.manager.create('worker-old', '/repo-workers/task-1', { branch: 'worker/task-1' });
    expect(original).not.toBeNull();
    session.computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const acceptanceId = session.nextAcceptanceId();
    session.recordAcceptance({
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreePath: original!.path,
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    });
    session.approveCleanup(original!.path, {
      worktreeId: original!.id,
      branch: original!.branch,
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      baseRevision: original!.baseRevision,
      stateSignature: 'sig-1',
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
    });

    session.manager.forget(original!.id);
    const replacement = await session.manager.create('worker-new', original!.path, { branch: original!.branch });
    expect(replacement).not.toBeNull();

    await expect(session.confirmAndCleanup(replacement!.path)).resolves.toBe(false);
    expect(session.manager.get(replacement!.id)?.status).toBe('created');
  });

  it('rejects cleanup when the live branch tip changes after approval', async () => {
    let tip = TIP_OID;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${tip}\n`);
      return ok();
    });
    const session = initDevSession({ baseRepoPath: '/repo', gitRunner: { git } });
    const info = await session.manager.create('worker-id', '/repo-workers/cas', { branch: 'worker/cas' });
    expect(info).not.toBeNull();
    session.computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const acceptanceId = session.nextAcceptanceId();
    session.recordAcceptance({
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreePath: info!.path,
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    });
    session.approveCleanup(info!.path, {
      worktreeId: info!.id,
      branch: info!.branch,
      branchRevision: TIP_OID,
      branchRevisionRequired: true,
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      attempt: 1,
      baseRevision: info!.baseRevision,
      stateSignature: 'sig-1',
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      taskStatus: 'succeeded',
      cleanupStatus: 'active',
    });
    const fingerprint = cleanupBindingFingerprint(session.getCleanupApproval(info!.path)!);
    session.registerTrustedCleanupBinding(trustedProposal(session, info!.path));
    tip = 'c'.repeat(40);
    await expect(session.confirmAndCleanup(info!.path, undefined, fingerprint)).resolves.toBe(false);
    expect(session.manager.get(info!.id)?.status).toBe('created');
    expect(session.getCleanupApproval(info!.path)?.consumed).toBe(true);
  });

  it('consumes approval when cancellation arrives after destructive cleanup completes', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const session = initDevSession({ baseRepoPath: '/repo', gitRunner: { git } });
    const info = await session.manager.create('worker-id', '/repo-workers/task-1', { branch: 'worker/task-1' });
    expect(info).not.toBeNull();
    session.computeWorktreeSignature = vi.fn(async () => 'sig-1');
    const acceptanceId = session.nextAcceptanceId();
    session.recordAcceptance({
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      worktreePath: info!.path,
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    });
    session.approveCleanup(info!.path, {
      worktreeId: info!.id,
      branch: info!.branch,
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      branchRevision: TIP_OID,
      branchRevisionRequired: true,
      baseRevision: info!.baseRevision,
      stateSignature: 'sig-1',
      acceptanceId,
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      attempt: 1,
      taskStatus: 'succeeded',
      cleanupStatus: 'active',
    });
    const controller = new AbortController();
    const cleanup = session.manager.cleanup.bind(session.manager);
    vi.spyOn(session.manager, 'cleanup').mockImplementation(async (id, opts) => {
      const result = await cleanup(id, opts);
      controller.abort();
      return result;
    });

    const fingerprint = cleanupBindingFingerprint(session.getCleanupApproval(info!.path)!);
    session.registerTrustedCleanupBinding(trustedProposal(session, info!.path));
    await expect(session.confirmAndCleanup(info!.path, controller.signal, fingerprint)).resolves.toBe(true);
    expect(session.isCleanupApproved(info!.path)).toBe(false);
  });

  it('keeps the worktree record when Tauri registration and rollback both fail', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { exitCode: 1, stdout: '', stderr: 'host gate rejected rollback', durationMs: 1 };
      }
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
      gitRunner: { git },
    });

    await expect(session.manager.create(
      'worker-id',
      '/repo-workers/task-1',
      { branch: 'worker/task-1' },
    )).rejects.toThrow('register rejected');
    expect(session.manager.get('worker-id')).toEqual(expect.objectContaining({
      path: '/repo-workers/task-1',
      status: 'created',
    }));
  });

  it('keeps a restored worktree record when Tauri registration fails', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ok('worktree C:/repo-workers/task-1\nHEAD base-1\nbranch refs/heads/worker/task-1\n');
      }
      return ok();
    });
    const session = initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: 'C:/repo',
      gitRunner: { git },
    });
    const info = {
      id: 'worker-id',
      path: 'C:/repo-workers/task-1',
      branch: 'worker/task-1',
      baseRevision: 'base-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'created' as const,
    };

    await expect(session.manager.restore(info)).resolves.toBe(false);
    expect(session.manager.get(info.id)).toEqual(expect.objectContaining({
      path: info.path,
      status: 'created',
    }));
  });

  it('rejects reusing a DevSession with a different host generation', () => {
    initDevSession({
      env: 'tauri',
      hostGeneration: 1,
      baseRepoPath: '/repo',
    });

    expect(() => initDevSession({
      env: 'tauri',
      hostGeneration: 2,
      baseRepoPath: '/repo',
    })).toThrow(/generation|session/);
  });

  it('rejects an acceptance that declares partial lineage provenance', () => {
    const session = initDevSession({ baseRepoPath: '/repo' });
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');

    expect(() => session.recordAcceptance({
      acceptanceId: 'acc-partial-lineage',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: '/repo-workers/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    })).toThrow(/runId|taskId|lineage/);
  });

  it('persists and reloads acceptance records with exact lineage across session restart', async () => {
    const stored: AcceptanceRecord[] = [];
    const persistence: AcceptancePersistence = {
      append: async (record) => {
        stored.push({ ...record });
      },
      load: async () => stored.map((record) => ({ ...record })),
    };
    const taskExecutionId = createTaskExecutionId('run-restart', 'task-1');
    const acceptance: AcceptanceRecord = {
      acceptanceId: 'acc-restart',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: '/repo-workers/run-restart/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
      runId: 'run-restart',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };
    const first = initDevSession({ baseRepoPath: '/repo', acceptancePersistence: persistence });
    const recorded = first.recordAcceptance(acceptance);
    await first.persistAcceptance(recorded);
    resetDevSession();

    const second = initDevSession({ baseRepoPath: '/repo', acceptancePersistence: persistence });
    await second.loadAcceptances();
    expect(second.getAcceptance(acceptance.acceptanceId)).toEqual(acceptance);
  });

  it('round-trips acceptance JSONL records whose fields contain newlines', async () => {
    const files = new Map<string, string>();
    const persistence = createHostAcceptanceStoreWithFs('/tmp/acceptance', '/tmp/workers/run-1', 'records', {
      mkdir: async () => {},
      append: async (path, text) => {
        files.set(path, `${files.get(path) ?? ''}${text}`);
      },
      read: async (path) => files.get(path) ?? '',
    });
    const taskExecutionId = createTaskExecutionId('run-newline', 'task-1');
    const acceptance: AcceptanceRecord = {
      acceptanceId: 'acceptance-newline',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: '/repo-workers/run-newline/task-1',
      passed: false,
      failedChecks: ['line one\nline two'],
      at: '2026-09-01T00:00:00.000Z',
      runId: 'run-newline',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 1),
    };
    const first = initDevSession({ baseRepoPath: '/repo', acceptancePersistence: persistence });
    await first.persistAcceptance(first.recordAcceptance(acceptance));
    resetDevSession();
    const second = initDevSession({ baseRepoPath: '/repo', acceptancePersistence: persistence });
    await second.loadAcceptances();
    expect(second.getAcceptance(acceptance.acceptanceId)).toEqual(acceptance);
  });

  it('returns cloned acceptance and cleanup approval snapshots', () => {
    const session = initDevSession({ baseRepoPath: '/repo' });
    const acceptance: AcceptanceRecord = {
      acceptanceId: 'acc-clone',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: '/repo-workers/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:00:00.000Z',
    };
    const recorded = session.recordAcceptance(acceptance);
    recorded.failedChecks.push('forged');
    expect(session.getAcceptance('acc-clone')?.failedChecks).toEqual([]);
    const listed = session.listAcceptances();
    listed[0].failedChecks.push('forged-again');
    expect(session.getAcceptance('acc-clone')?.failedChecks).toEqual([]);

    session.approveCleanup('/repo-workers/task-1', { branch: 'worker/task-1' });
    const approval = session.getCleanupApproval('/repo-workers/task-1');
    expect(approval).toBeDefined();
    approval!.consumed = true;
    approval!.branch = 'worker/forged';
    expect(session.getCleanupApproval('/repo-workers/task-1')).toMatchObject({
      consumed: false,
      branch: 'worker/task-1',
    });
    const approvals = session.listCleanupApprovals();
    approvals[0].consumed = true;
    expect(session.getCleanupApproval('/repo-workers/task-1')?.consumed).toBe(false);
  });

});
