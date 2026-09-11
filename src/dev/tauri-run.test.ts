/**
 * tauri-run 单元测试：纯前端路径工具（resolveWeb/relativeWeb）与 deps 注入逻辑。
 * 命令通道本身由 Rust 侧校验，这里只测前端路径解析（GUI 下 node:path 不可用的替代实现）。
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveWeb, relativeWeb } from './path-utils';
import { createTauriDeps } from './tauri-run';

const invoke = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('resolveWeb（GUI 纯前端路径解析）', () => {
  it('相对路径基于 root 拼接', () => {
    expect(resolveWeb('/repo/wt', 'src/a.ts')).toBe('/repo/wt/src/a.ts');
  });

  it('解析 ../ 归一化', () => {
    expect(resolveWeb('/repo/wt', 'src/../a.ts')).toBe('/repo/wt/a.ts');
  });

  it('逃逸 ../ 弹出 root 段（绝对路径 root 下不允许越到根外）', () => {
    // '/repo/wt' + '../../x' → /x（弹出 repo、wt），这是纯前端近似；真实逃逸判定
    // 由 createTauriDeps.resolveInside 的 startWith 检查兜底（见下）。
    expect(resolveWeb('/repo/wt', '../../x')).toBe('/x');
  });

  it('Windows 盘符路径保留盘符', () => {
    expect(resolveWeb('C:/repo/wt', 'src\\a.ts')).toBe('C:/repo/wt/src/a.ts');
  });

  it('preserves UNC roots and compares them case-insensitively', () => {
    expect(resolveWeb('//Server/Share/repo', 'wt/file.ts')).toBe('//Server/Share/repo/wt/file.ts');
    expect(relativeWeb('//Server/Share/repo', '//server/share/repo/wt/file.ts')).toBe('wt/file.ts');
  });

  it('relativeWeb：同前缀 → 相对子路径；跨前缀 → 回溯 ..', () => {
    expect(relativeWeb('/repo/wt', '/repo/wt/src/a.ts')).toBe('src/a.ts');
    expect(relativeWeb('/repo/wt', '/repo/other/b.ts')).toBe('../other/b.ts');
    expect(relativeWeb('/repo/wt', '/repo/wt')).toBe('.');
  });
});

describe('createTauriDeps.resolveInside（逃逸判定）', () => {
  const deps = createTauriDeps(1);

  it('root 内路径放行', async () => {
    expect(await deps.resolveInside!('/repo/wt', 'src/a.ts')).toBe('/repo/wt/src/a.ts');
  });

  it('逃逸到 root 外 → 抛错（fail-closed）', async () => {
    await expect(deps.resolveInside!('/repo/wt', '../../secret.ts')).rejects.toThrow(/逃逸/);
  });

  it('passes the Rust session generation with host command calls', async () => {
    invoke.mockClear();
    const deps = createTauriDeps(17);

    await deps.runCommand!('pwd', [], '/repo/wt');

    expect(invoke).toHaveBeenCalledWith('dev_exec', {
      args: ['pwd'],
      cwd: '/repo/wt',
      generation: 17,
    });
  });
});
