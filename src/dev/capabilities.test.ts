import { describe, it, expect } from 'vitest';
import { applyUnifiedPatch, createNodeDevService, type NodeDevDeps } from './capabilities';
import { defaultDevPolicy } from './policy';
import type { CommandResult } from './node-run';

describe('H4 applyUnifiedPatch', () => {
  it('应用上下文补丁：替换 + 新增行', () => {
    const original = 'line1\nline2\nline3\n';
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2-edit',
      ' line3',
      '+line4',
    ].join('\n');
    const r = applyUnifiedPatch(original, patch);
    expect(r.ok).toBe(true);
    // 原文件以 \n 结尾，结果保留尾随换行（split/join 语义）
    expect(r.result).toBe('line1\nline2-edit\nline3\nline4\n');
  });

  it('上下文不匹配 → 失败（防错位覆盖）', () => {
    const r = applyUnifiedPatch('aaa\nbbb\n', '--- a\n+++ b\n@@ -1,2 +1,1 @@\n-ccc\n+xxx\n');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不匹配');
  });

  it('无 hunk → 失败', () => {
    const r = applyUnifiedPatch('abc', '--- a\n+++ b\n');
    expect(r.ok).toBe(false);
  });

  it('新增文件（全 + 行）可用，删除文件（全 - 行）可为空', () => {
    const add = applyUnifiedPatch('', '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n');
    expect(add.ok).toBe(true);
    expect(add.result).toBe('hello\n');
    const del = applyUnifiedPatch('bye\n', '--- a\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n');
    expect(del.ok).toBe(true);
    expect(del.result).toBe('');
  });
});

describe('H4 createNodeDevService（注入 fake deps）', () => {
  const files = new Map<string, string>([['src/components/A.tsx', 'export const a = 1;\n']]);

  const fakeDeps: NodeDevDeps = {
    runCommand: async (cmd, args, _cwd) => {
      if (cmd === 'git' && args[0] === 'status') {
        return { exitCode: 0, stdout: ' M src/components/A.tsx\n', stderr: '', durationMs: 1 };
      }
      if (cmd === 'git' && args[0] === 'diff') {
        return { exitCode: 0, stdout: 'diff --git a/src/components/A.tsx b/src/components/A.tsx\n', stderr: '', durationMs: 1 };
      }
      if (cmd === 'npm' && args[0] === 'run') {
        return { exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 2 };
      }
      const r: CommandResult = { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
      return r;
    },
    readFile: async (abs) => {
      const rel = abs.replace(/\\/g, '/').split('/worktree/')[1];
      const hit = files.get(rel);
      if (!hit) throw new Error(`no file ${abs}`);
      return hit;
    },
    writeFile: async (abs, content) => {
      const rel = abs.replace(/\\/g, '/').split('/worktree/')[1];
      files.set(rel, content);
    },
    resolveInside: async (root, rel) => {
      const p = root.endsWith('/') ? root + rel : `${root}/${rel}`;
      return p;
    },
  };

  const ctx = { cwd: '/repo/worktree' };

  it('codeRead：允许路径可读，受保护路径拒绝', async () => {
    const svc = createNodeDevService(defaultDevPolicy, fakeDeps);
    const r = await svc.codeRead('src/components/A.tsx', ctx);
    expect(r.content).toBe('export const a = 1;\n');
    expect(r.lineCount).toBe(2);
    await expect(svc.codeRead('src/orchestrator/run.ts', ctx)).rejects.toThrow(/受保护/);
    await expect(svc.codeRead('src/store/workflowStore.ts', ctx)).rejects.toThrow(/受保护/);
  });

  it('codePatch：受控 diff 落盘 + contentHash；白名单外命令拒绝', async () => {
    const svc = createNodeDevService(defaultDevPolicy, fakeDeps);
    const patch = '--- a\n+++ b\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
    const r = await svc.codePatch('src/components/A.tsx', patch, ctx);
    expect(r.ok).toBe(true);
    expect(r.contentHash).toBeTruthy();
    expect(files.get('src/components/A.tsx')).toBe('export const a = 2;\n');
    // 危险命令 shell 拒绝
    const rm = await svc.shellRun(['rm', '-rf', '/'], ctx);
    expect(rm.exitCode).toBe(-1);
    expect(rm.stderr).toContain('白名单');
  });

  it('testRun/shellRun 白名单放行；gitStatus/gitDiff 走 git', async () => {
    const svc = createNodeDevService(defaultDevPolicy, fakeDeps);
    const t = await svc.testRun(['npm', 'run', 'test'], ctx);
    expect(t.exitCode).toBe(0);
    expect(t.stdout).toContain('PASS');
    const status = await svc.gitStatus(ctx);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('A.tsx');
    const diff = await svc.gitDiff('HEAD', ctx);
    expect(diff.stdout).toContain('diff --git');
  });

  it('gitChangedFiles：合并 tracked diff 与 untracked', async () => {
    const svc = createNodeDevService(defaultDevPolicy, {
      ...fakeDeps,
      runCommand: async (cmd, args, _cwd) => {
        if (cmd === 'git' && args[0] === 'diff') {
          return { exitCode: 0, stdout: 'src/components/A.tsx\n', stderr: '', durationMs: 1 };
        }
        if (cmd === 'git' && args[0] === 'ls-files') {
          return { exitCode: 0, stdout: 'docs/new.md\n', stderr: '', durationMs: 1 };
        }
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
      },
    });
    const filesChanged = await svc.gitChangedFiles(ctx);
    expect(filesChanged).toContain('src/components/A.tsx');
    expect(filesChanged).toContain('docs/new.md');
  });
});
