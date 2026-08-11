import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager, createNodeGitRunner } from './worktree';
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
    expect(m.list()).toHaveLength(1);

    const cleaned = await m.cleanup('t1');
    expect(cleaned).toBe(true);
    expect(m.get('t1')?.status).toBe('cleaned');
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/t1']);
    expect(calls).toContainEqual(['branch', '-D', info!.branch]);
    // 二次清理返回 false（幂等）
    expect(await m.cleanup('t1')).toBe(false);
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
    expect(await m.cleanup('t1')).toBe(false);
    expect(m.get('t1')?.status).toBe('created'); // 保留现场
  });

  it('createNodeGitRunner：真实 runner 结构可用', async () => {
    const runner = createNodeGitRunner();
    const r = await runner.git(['--version'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('git version');
  });
});
