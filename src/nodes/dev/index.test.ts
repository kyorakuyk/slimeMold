import { describe, it, expect } from 'vitest';
import { createDevNodeDefs } from './index';
import type { DevSession } from '../../dev/session';
import { WorktreeManager } from '../../dev/worktree';
import { createNodeDevService, type NodeDevDeps } from '../../dev/capabilities';
import { defaultDevPolicy } from '../../dev/policy';
import { EvidenceCollector } from '../../dev/evidence';
import type { CommandResult } from '../../dev/node-run';

function fakeSession(): DevSession {
  const git = async (args: string[], _cwd: string): Promise<CommandResult> => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '', durationMs: 1 };
    if (args[0] === 'worktree') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    if (args[0] === 'ls-files') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
  };
  const manager = new WorktreeManager({ git }, '/repo');
  const registry = { isTracked: (cwd: string) => manager.isTracked(cwd) };
  const files = new Map<string, string>([['src/components/A.tsx', 'export const a = 1;\n']]);
  const deps: NodeDevDeps = {
    runCommand: async (cmd, _args) => {
      if (cmd === 'git') return { exitCode: 0, stdout: ' M src/components/A.tsx\n', stderr: '', durationMs: 1 };
      return { exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 1 };
    },
    // abs 是 resolve 后的绝对路径（Windows 盘符前缀），取 /wt/ 之后的相对部分做 key
    readFile: async (abs) => {
      const rel = abs.replace(/\\/g, '/').split('/wt/')[1]?.split('/').slice(1).join('/');
      const hit = files.get(rel ?? abs);
      if (!hit) throw new Error(`no file ${abs}`);
      return hit;
    },
    writeFile: async (abs, content) => {
      const rel = abs.replace(/\\/g, '/').split('/wt/')[1]?.split('/').slice(1).join('/');
      files.set(rel ?? abs, content);
    },
    resolveInside: async (root, rel) => (await import('node:path')).resolve(root, rel),
    relativePath: async (root, abs) => (await import('node:path')).relative(root, abs).replace(/\\/g, '/'),
  };
  const service = createNodeDevService(defaultDevPolicy, deps, registry);
  const collector = new EvidenceCollector();
  return { policy: defaultDevPolicy, manager, service, collector, defs: [] };
}

describe('H4 dev nodes', () => {
  it('createDevNodeDefs：返回 11 个 dev.* 节点', () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    expect(defs).toHaveLength(11);
    for (const d of defs) {
      expect(d.typeId.startsWith('dev.')).toBe(true);
      expect(d.category).toBe('开发');
      expect(typeof d.execute).toBe('function');
    }
    const ids = defs.map((d) => d.typeId);
    expect(ids).toContain('dev.worktree.create');
    expect(ids).toContain('dev.code.read');
    expect(ids).toContain('dev.accept');
  });

  it('dev.worktree.create 登记后，dev.code.read 可读 allowed 路径', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const byId = new Map(defs.map((d) => [d.typeId, d]));
    const create = byId.get('dev.worktree.create')!;
    const created = await create.execute({ path: '/repo/wt/t1' }, {}, {} as never);
    expect(created.ok).toBe(true);
    expect(created.path).toBe('/repo/wt/t1');

    const read = byId.get('dev.code.read')!;
    const r = await read.execute({ worktreePath: '/repo/wt/t1', path: 'src/components/A.tsx' }, {}, {} as never);
    expect(r.content).toBe('export const a = 1;\n');
    expect(r.lineCount).toBe(2);
  });

  it('dev.code.read：未登记 cwd 拒绝（fail-closed）', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const read = defs.find((d) => d.typeId === 'dev.code.read')!;
    await expect(
      read.execute({ worktreePath: '/repo/main', path: 'src/components/A.tsx' }, {}, {} as never),
    ).rejects.toThrow(/不属于已登记的 worktree/);
  });

  it('dev.code.patch：应用受控补丁 + 内容哈希', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t2' }, {}, {} as never);
    const patch = defs.find((d) => d.typeId === 'dev.code.patch')!;
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
    const r = await patch.execute(
      { worktreePath: '/repo/wt/t2', path: 'src/components/A.tsx', patch: diff },
      {},
      {} as never,
    );
    expect(r.ok).toBe(true);
    expect(r.contentHash).toBeTruthy();
  });

  it('dev.shell.run：白名单放行/拒绝；dev.test.run 捕获退出码', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t3' }, {}, {} as never);
    const shell = defs.find((d) => d.typeId === 'dev.shell.run')!;
    const okRun = await shell.execute(
      { worktreePath: '/repo/wt/t3', cmd: ['git', 'status', '--porcelain'] },
      {},
      {} as never,
    );
    expect(okRun.exitCode).toBe(0);
    const badRun = await shell.execute(
      { worktreePath: '/repo/wt/t3', cmd: ['git', 'push'] },
      {},
      {} as never,
    );
    expect(badRun.exitCode).toBe(-1);
    const test = defs.find((d) => d.typeId === 'dev.test.run')!;
    const t = await test.execute({ worktreePath: '/repo/wt/t3', cmd: ['tsc', '--noEmit'] }, {}, {} as never);
    expect(t.exitCode).toBe(0);
  });

  it('dev.evidence.add → dev.accept：证据满足规则则通过，触碰保护路径则失败', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const byId = new Map(defs.map((d) => [d.typeId, d]));
    const evAdd = byId.get('dev.evidence.add')!;
    await evAdd.execute(
      { orchestrationId: 'o1', stageId: 's1', kind: 'test', summary: 'tsc 通过', exitCode: 0, command: 'tsc --noEmit' },
      {},
      {} as never,
    );
    expect(session.collector.records).toHaveLength(1);
    expect(session.collector.records[0].capturedBy).toBe('host');

    const accept = byId.get('dev.accept')!;
    const rules = [{ id: 'typecheck', kind: 'test', command: 'tsc --noEmit' }];
    const ok = await accept.execute(
      { rules, evidence: session.collector.toJSON(), changedProtectedPaths: [], uncertainties: [] },
      {},
      {} as never,
    );
    expect(ok.passed).toBe(true);

    const bad = await accept.execute(
      { rules, evidence: session.collector.toJSON(), changedProtectedPaths: ['src/orchestrator/run.ts'], uncertainties: [] },
      {},
      {} as never,
    );
    expect(bad.passed).toBe(false);
    expect(bad.changedProtectedPaths).toContain('src/orchestrator/run.ts');
  });

  it('dev.worktree.cleanup：未确认拒绝，确认后清理', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t4' }, {}, {} as never);
    const cleanup = defs.find((d) => d.typeId === 'dev.worktree.cleanup')!;
    const noConfirm = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, { confirm: false }, {} as never);
    expect(noConfirm.cleaned).toBe(false);
    expect(session.manager.isTracked('/repo/wt/t4')).toBe(true);
    const confirmed = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, { confirm: true }, {} as never);
    expect(confirmed.cleaned).toBe(true);
    expect(session.manager.isTracked('/repo/wt/t4')).toBe(false);
  });
});
