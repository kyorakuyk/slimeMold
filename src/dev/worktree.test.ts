import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager, createNodeGitRunner, workerBranchForPath } from './worktree';
import type { CommandResult } from './node-run';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
}

const TIP_OID = 'b'.repeat(40);
const RECREATED_OID = 'c'.repeat(40);

describe('H4 WorktreeManager（fake git runner）', () => {
  it('create：rev-parse 失败（非 git 仓库）→ null，不创建', async () => {
    const git = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'not a repo', durationMs: 1 }));
    const m = new WorktreeManager({ git }, '/repo');
    const info = await m.create('t1', '/wt/t1');
    expect(info).toBeNull();
    expect(git).toHaveBeenCalledWith(['rev-parse', 'HEAD'], '/repo');
  });

  it('create：绝对 worktree 路径不会把路径字符带入 Git branch', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const m = new WorktreeManager({ git }, 'D:/Temp/slimemold-fixture');
    const target = 'D:/Temp/slimemold-fixture-workers/mvp-success-wt';

    const info = await m.create(target, target);

    expect(info).not.toBeNull();
    expect(info!.branch).toMatch(/^dev-[A-Za-z0-9._-]+-[a-z0-9]+$/);
    expect(info!.branch).not.toMatch(/[\\/:]/);
    expect(calls).toContainEqual(['worktree', 'add', '-q', target, '-b', info!.branch, 'HEAD']);
  });

  it('create：worker branch 先创建 sibling worker parent directory', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: '', durationMs: 1 };
      return ok();
    });
    const ensureParent = vi.fn(async () => {});
    const manager = new WorktreeManager({ git }, 'D:/Temp/repo', ensureParent);

    const info = await manager.create('worker-1', 'D:/Temp/repo-workers/worker-1', {
      branch: 'worker/worker-1',
    });

    expect(info?.status).toBe('created');
    expect(ensureParent).toHaveBeenCalledWith('D:/Temp/repo-workers');
    expect(calls.at(-1)).toEqual([
      'worktree', 'add', '-q', 'D:/Temp/repo-workers/worker-1', '-b', 'worker/worker-1', 'HEAD',
    ]);
  });

  it('create：base tip 一致的 orphan worker branch 使用已有 branch 接管 worktree', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'show-ref') return ok('abc123 refs/heads/worker/orphan-1\n');
      if (args[0] === 'rev-parse' && args[1] === 'worker/orphan-1') return ok('abc123\n');
      return ok();
    });
    const manager = new WorktreeManager({ git }, 'D:/Temp/repo');

    const info = await manager.create('orphan-1', 'D:/Temp/repo-workers/orphan-1', {
      branch: 'worker/orphan-1',
    });

    expect(info?.branch).toBe('worker/orphan-1');
    expect(calls).toContainEqual(['worktree', 'add', '-q', 'D:/Temp/repo-workers/orphan-1', 'worker/orphan-1']);
  });

  it('workerBranchForPath：与 Git/Rust branch 组件规则一致', () => {
    expect(workerBranchForPath('D:/Temp/repo-workers/mvp-gui-success-wt/')).toBe('worker/mvp-gui-success-wt');
    const windowsPath = ['D:', 'Temp', 'repo-workers', 'mvp-gui-success-wt', ''].join(String.fromCharCode(92));
    expect(workerBranchForPath(windowsPath)).toBe('worker/mvp-gui-success-wt');
    expect(workerBranchForPath('C:/repo-workers\\mixed-separator')).toBe('worker/mixed-separator');

    for (const path of [
      '/repo-workers/foo..bar',
      '/repo-workers/.hidden',
      '/repo-workers/foo.',
      '/repo-workers/foo.lock',
      '/repo-workers/Foo.LOCK',
      '/repo-workers/./foo',
      '/repo-workers/../repo-workers/foo',
      `/repo-workers/${'a'.repeat(201)}`,
    ]) {
      expect(() => workerBranchForPath(path)).toThrow(/(?:path|basename) 无效/);
    }
  });

  it('Worker-scoped create/restore：只接受 base sibling Worker root 与 branch-basename 对', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ok('worktree D:/repo-workers/attempt-1\nHEAD abc123\nbranch refs/heads/worker/attempt-1\n');
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'D:/repo');

    await expect(m.create('attempt-1', 'D:/repo-workers/attempt-1', {
      branch: 'worker/attempt-1',
    })).resolves.not.toBeNull();
    await expect(m.create('outside', 'D:/repo/outside', {
      branch: 'worker/outside',
    })).resolves.toBeNull();
    await expect(m.create('foldback', 'D:/repo-workers/../repo-workers/foldback', {
      branch: 'worker/foldback',
    })).resolves.toBeNull();
    await expect(m.create('mismatch', 'D:/repo-workers/mismatch', {
      branch: 'worker/other',
    })).resolves.toBeNull();
    expect(calls).not.toContainEqual(['worktree', 'add', '-q', 'D:/repo/outside', '-b', 'worker/outside', 'HEAD']);

    const restored = await m.restore({
      id: 'restored-outside',
      path: 'D:/repo/outside',
      branch: 'worker/outside',
      baseRevision: 'abc123',
      createdAt: '2026-09-05T00:00:00.000Z',
      status: 'created',
    });
    expect(restored).toBe(false);
  });

  it('restores registration-pending lineage without requiring a live worktree', async () => {
    const git = vi.fn(async () => ok());
    const m = new WorktreeManager({ git }, 'D:/repo');
    const info = {
      id: 'pending-1',
      path: 'D:/repo-workers/pending-1',
      branch: 'worker/pending-1',
      baseRevision: 'abc123',
      createdAt: '2026-09-05T00:00:00.000Z',
      status: 'registration-pending' as const,
    };

    await expect(m.restore(info)).resolves.toBe(true);
    expect(m.get(info.id)).toEqual(info);
    await expect(m.cleanup(info.id, { confirm: true })).resolves.toBe(true);
    expect(m.get(info.id)?.status).toBe('registration-pending');
  });

  it('create→list→cleanup 完整生命周期', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree') return ok();
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    const info = await m.create('t1', '/wt/t1');
    expect(info).not.toBeNull();
    expect(info!.baseRevision).toBe('abc123');
    expect(info!.status).toBe('created');
    expect(calls).toContainEqual(['worktree', 'add', '-q', '/wt/t1', '-b', info!.branch, 'HEAD']);

    expect(m.get('t1')?.path).toBe('/wt/t1');
    expect(m.getByPath('/wt/t1')?.id).toBe('t1');
    expect(m.list()).toHaveLength(1);
    // P0：isTracked/assertTracked——已登记放行，未登记/清理后拒绝
    expect(m.isTracked('/wt/t1')).toBe(true);
    expect(m.isTracked('/repo')).toBe(false);
    expect(() => m.assertTracked('/wt/t1')).not.toThrow();
    expect(() => m.assertTracked('/repo')).toThrow(/不属于任何已登记的 worktree/);
    // P1（审计）：resolve 规范化后，折返路径也判定为同一 worktree（合法放行，防误拒）
    expect(m.isTracked('/wt/t1/../t1')).toBe(true);
    expect(m.isTrackedOrChild('/wt/t1/src')).toBe(true);
    expect(m.isTrackedOrChild('/wt/t1-sibling/src')).toBe(false);
    expect(m.isTracked('C:/wt/t1')).toBe(false); // 不同盘符 ≠ 匹配

    // 审计确认门：未显式 confirm 拒绝清理（防误删未提交改动）
    expect(await m.cleanup('t1')).toBe(false);
    expect(m.get('t1')?.status).toBe('created');
    // 无未提交改动时 hasUncommittedChanges = false
    expect(await m.hasUncommittedChanges('t1')).toBe(false);

    const cleaned = await m.cleanup('t1', { confirm: true });
    expect(cleaned).toBe(true);
    expect(m.get('t1')?.status).toBe('cleaned');
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/t1']);
    expect(calls).toContainEqual([
      'update-ref',
      '-d',
      `refs/heads/${info!.branch}`,
      TIP_OID,
    ]);
    // 二次清理返回 false（幂等）
    expect(await m.cleanup('t1', { confirm: true })).toBe(false);
  });

  it('hasUncommittedChanges：有 tracked diff 或 untracked 文件 → true', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('h1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'diff' && args[1] === '--quiet') {
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1 }; // 有未提交改动
      }
      if (args[0] === 'ls-files') return ok('docs/new.md\n');
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    await m.create('t1', '/wt/t1');
    expect(await m.hasUncommittedChanges('t1')).toBe(true);
  });

  it('cleanup 失败（git 报错）→ 保留现场返回 false', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('h1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { exitCode: 128, stdout: '', stderr: 'branch checked out', durationMs: 1 };
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    await m.create('t1', '/wt/t1');
    expect(await m.cleanup('t1', { confirm: true })).toBe(false);
    expect(m.get('t1')?.status).toBe('created'); // 保留现场
  });

  it('cleanup uses an atomic branch compare-and-delete after capturing the tip', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    const info = await m.create('t1', '/repo-workers/t1', { branch: 'worker/t1' });
    expect(info).not.toBeNull();

    await expect(m.cleanup('t1', { confirm: true })).resolves.toBe(true);
    expect(calls).toContainEqual([
      'rev-parse',
      '--verify',
      '--end-of-options',
      'refs/heads/worker/t1^{commit}',
    ]);
    expect(calls).toContainEqual([
      'update-ref',
      '-d',
      'refs/heads/worker/t1',
      TIP_OID,
    ]);
    expect(calls.some((args) => args[0] === 'branch')).toBe(false);
  });

  it('refuses cleanup before worktree removal when branch tip provenance cannot be read', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: 'ref unavailable', durationMs: 1 };
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    await m.create('t1', '/repo-workers/t1', { branch: 'worker/t1' });

    await expect(m.cleanup('t1', { confirm: true })).resolves.toBe(false);
    expect(m.get('t1')?.status).toBe('created');
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
  });

  it('stops normal cleanup when cancellation arrives while reading branch provenance', async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') {
        controller.abort();
        return ok(`${TIP_OID}\n`);
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    await m.create('t1', '/repo-workers/t1', { branch: 'worker/t1' });

    await expect(m.cleanup('t1', { confirm: true, signal: controller.signal })).resolves.toBe(false);
    expect(m.get('t1')?.status).toBe('created');
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
  });

  it('orphaned cleanup retries branch deletion without removing the worktree again', async () => {
    let removeCalls = 0;
    let branchCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('h1\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls += 1;
        return removeCalls === 1 ? ok() : { exitCode: 1, stdout: '', stderr: 'already removed', durationMs: 1 };
      }
      if (args[0] === 'update-ref') {
        branchCalls += 1;
        return branchCalls === 1 ? { exitCode: 1, stdout: '', stderr: 'temporary branch failure', durationMs: 1 } : ok();
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, '/repo');
    const info = await m.create('t1', '/wt/t1');
    expect(info).not.toBeNull();

    expect(await m.cleanup('t1', { confirm: true })).toBe(false);
    expect(m.get('t1')?.status).toBe('orphaned');
    expect(await m.cleanup('t1', {
      confirm: true,
      branchRevision: m.get('t1')?.branchRevision,
    })).toBe(true);
    expect(m.get('t1')?.status).toBe('cleaned');
    expect(removeCalls).toBe(1);
    expect(branchCalls).toBe(2);
    expect(git.mock.calls.every(([args]) => args[0] !== 'branch')).toBe(true);
  });

  it('refuses orphan retry when the branch name was recreated at a different revision', async () => {
    let branchRevision = TIP_OID;
    let branchDeleteCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${branchRevision}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'worktree' && args[1] === 'remove') return ok();
      if (args[0] === 'update-ref') {
        branchDeleteCalls += 1;
        return { exitCode: 1, stdout: '', stderr: 'temporary branch failure', durationMs: 1 };
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');
    await m.create('orphan-recreated', 'C:/repo-workers/orphan-recreated', { branch: 'worker/orphan-recreated' });

    expect(await m.cleanup('orphan-recreated', { confirm: true })).toBe(false);
    expect(m.get('orphan-recreated')).toMatchObject({ status: 'orphaned', branchRevision: TIP_OID });

    branchRevision = RECREATED_OID;
    expect(await m.cleanup('orphan-recreated', { confirm: true })).toBe(false);
    expect(branchDeleteCalls).toBe(1);
    expect(git.mock.calls.every(([args]) => args[0] !== 'branch')).toBe(true);
  });

  it('createNodeGitRunner：真实 runner 结构可用', async () => {
    const runner = createNodeGitRunner();
    const r = await runner.git(['--version'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('git version');
  });

  it('restore：只接受 git worktree list 中、且不等于主仓库的 worktree', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ok('worktree C:/repo-workers/task-1\nHEAD abc123\nbranch refs/heads/worker/task-1\n');
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');
    const mainRepoInfo = {
      id: 'wt-1',
      path: 'C:/repo',
      branch: 'worker/task-1',
      baseRevision: 'abc123',
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'created' as const,
    };
    const liveInfo = { ...mainRepoInfo, path: 'C:/repo-workers/task-1' };

    await expect(m.restore(mainRepoInfo)).resolves.toBe(false);
    await expect(m.restore(liveInfo)).resolves.toBe(true);
    expect(m.isTracked(liveInfo.path)).toBe(true);
    expect(git).toHaveBeenCalledWith(['worktree', 'list', '--porcelain'], 'C:/repo');
  });

  it('restores an orphaned record by branch provenance without requiring a live worktree', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');
    const info = {
      id: 'orphan-1',
      path: 'C:/repo-workers/orphan-1',
      branch: 'worker/orphan-1',
      baseRevision: 'base-1',
      branchRevision: TIP_OID,
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'orphaned' as const,
    };

    await expect(m.restore(info)).resolves.toBe(true);
    expect(m.get(info.id)).toEqual(expect.objectContaining({ status: 'orphaned', branchRevision: TIP_OID }));
    await expect(m.cleanup(info.id, { confirm: true, branchRevision: info.branchRevision })).resolves.toBe(true);
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'list')).toBe(false);
    expect(calls).toContainEqual(['update-ref', '-d', 'refs/heads/worker/orphan-1', TIP_OID]);
  });

  it('does not register a restored worktree after cancellation', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        await new Promise<void>((resolve) => { release = resolve; });
        return ok('worktree C:/repo-workers/task-1\nHEAD abc123\nbranch refs/heads/worker/task-1\n');
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');
    const info = {
      id: 'wt-1',
      path: 'C:/repo-workers/task-1',
      branch: 'worker/task-1',
      baseRevision: 'abc123',
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'created' as const,
    };

    const restoring = m.restore(info, { signal: controller.signal });
    controller.abort();
    release();

    await expect(restoring).resolves.toBe(false);
    expect(m.isTracked(info.path)).toBe(false);
  });

  it('cleans an added worktree when cancellation arrives after git add', async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') {
        controller.abort();
        return ok();
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');

    await expect(m.create('wt-1', 'C:/repo-workers/attempt-1', {
      branch: 'worker/attempt-1',
      signal: controller.signal,
    })).resolves.toBeNull();
    expect(m.list()).toEqual([]);
    expect(calls).toContainEqual(['worktree', 'remove', '--force', 'C:/repo-workers/attempt-1']);
    expect(calls).toContainEqual([
      'update-ref',
      '-d',
      'refs/heads/worker/attempt-1',
      TIP_OID,
    ]);
  });

  it('preserves create lineage when cancellation rollback cannot remove the worktree', async () => {
    const controller = new AbortController();
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
      if (args[0] === 'rev-parse') return ok(`${TIP_OID}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') {
        controller.abort();
        return ok();
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { exitCode: 128, stdout: '', stderr: 'worktree busy', durationMs: 1 };
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');

    await expect(m.create('wt-rollback', 'C:/repo-workers/rollback', {
      branch: 'worker/rollback',
      signal: controller.signal,
    })).resolves.toBeNull();
    expect(m.get('wt-rollback')).toMatchObject({
      path: 'C:/repo-workers/rollback',
      branch: 'worker/rollback',
      status: 'created',
    });
  });
});
