import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager, createNodeGitRunner, workerBranchForPath } from './worktree';
import type { CommandResult } from './node-run';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
}

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
      if (args[0] === 'rev-parse') return ok('abc123\n');
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
      if (args[0] === 'rev-parse') return ok('abc123\n');
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

  it('create→list→cleanup 完整生命周期', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return ok('abc123\n');
      if (args[0] === 'worktree') return ok();
      if (args[0] === 'branch') return ok();
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
    expect(calls).toContainEqual(['branch', '-D', info!.branch]);
    // 二次清理返回 false（幂等）
    expect(await m.cleanup('t1', { confirm: true })).toBe(false);
  });

  it('hasUncommittedChanges：有 tracked diff 或 untracked 文件 → true', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('h1\n');
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
      if (args[0] === 'rev-parse') return ok('h1\n');
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

  it('orphaned cleanup retries branch deletion without removing the worktree again', async () => {
    let removeCalls = 0;
    let branchCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('h1\n');
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls += 1;
        return removeCalls === 1 ? ok() : { exitCode: 1, stdout: '', stderr: 'already removed', durationMs: 1 };
      }
      if (args[0] === 'branch') {
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
    expect(await m.cleanup('t1', { confirm: true })).toBe(true);
    expect(m.get('t1')?.status).toBe('cleaned');
    expect(removeCalls).toBe(1);
    expect(branchCalls).toBe(2);
  });

  it('refuses orphan retry when the branch name was recreated at a different revision', async () => {
    let branchRevision = 'orphan-tip';
    let branchDeleteCalls = 0;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('base-1\n');
      if (args[0] === 'rev-parse') return ok(`${branchRevision}\n`);
      if (args[0] === 'worktree' && args[1] === 'add') return ok();
      if (args[0] === 'worktree' && args[1] === 'remove') return ok();
      if (args[0] === 'branch') {
        branchDeleteCalls += 1;
        return { exitCode: 1, stdout: '', stderr: 'temporary branch failure', durationMs: 1 };
      }
      return ok();
    });
    const m = new WorktreeManager({ git }, 'C:/repo');
    await m.create('orphan-recreated', 'C:/repo-workers/orphan-recreated', { branch: 'worker/orphan-recreated' });

    expect(await m.cleanup('orphan-recreated', { confirm: true })).toBe(false);
    expect(m.get('orphan-recreated')).toMatchObject({ status: 'orphaned', branchRevision: 'orphan-tip' });

    branchRevision = 'recreated-tip';
    expect(await m.cleanup('orphan-recreated', { confirm: true })).toBe(false);
    expect(branchDeleteCalls).toBe(1);
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
      if (args[0] === 'rev-parse') return ok('abc123\n');
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
    expect(calls).toContainEqual(['branch', '-D', 'worker/attempt-1']);
  });

  it('preserves create lineage when cancellation rollback cannot remove the worktree', async () => {
    const controller = new AbortController();
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('abc123\n');
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
