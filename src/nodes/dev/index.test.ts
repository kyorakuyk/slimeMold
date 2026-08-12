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
    runCommand: async (cmd, args) => {
      if (cmd === 'git') {
        if (args[0] === 'diff' && args.includes('--name-only')) {
          return { exitCode: 0, stdout: 'docs/new.md\n', stderr: '', durationMs: 1 };
        }
        if (args[0] === 'diff') {
          // git diff HEAD：空 stdout（无实际变更）
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        }
        if (args[0] === 'ls-files') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        return { exitCode: 0, stdout: ' M src/components/A.tsx\n', stderr: '', durationMs: 1 };
      }
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
  const session: DevSession = {
    policy: defaultDevPolicy,
    manager,
    service,
    collector,
    resultStore: new Map(),
    approvedCleanups: new Map(),
    defs: [],
    registerResult(rec) {
      this.resultStore.set(rec.resultId, rec);
      return rec;
    },
    approveCleanup(path, opts) {
      const key = path.replace(/\\/g, '/').replace(/\/+$/, '');
      this.approvedCleanups.set(key, {
        worktreePath: key,
        baseRevision: opts?.baseRevision,
        acceptanceId: opts?.acceptanceId,
        approvedAt: '2026-01-01T00:00:00.000Z',
        consumed: false,
      });
    },
    isCleanupApproved(path) {
      const a = this.approvedCleanups.get(path.replace(/\\/g, '/').replace(/\/+$/, ''));
      return !!a && !a.consumed;
    },
    consumeCleanup(path) {
      const key = path.replace(/\\/g, '/').replace(/\/+$/, '');
      const a = this.approvedCleanups.get(key);
      if (a) this.approvedCleanups.set(key, { ...a, consumed: true });
    },
  };
  return session;
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

  it('dev.evidence.add → dev.accept：只能引用宿主登记结果，伪造 resultId 拒绝；验收只读宿主证据', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const byId = new Map(defs.map((d) => [d.typeId, d]));
    // P0：伪造 resultId 拒绝（证据必须来自真实执行）
    const evAdd = byId.get('dev.evidence.add')!;
    await expect(
      evAdd.execute({ orchestrationId: 'o1', stageId: 's1', resultId: 'fake' }, {}, {} as never),
    ).rejects.toThrow(/宿主结果不存在/);
    expect(session.collector.records).toHaveLength(0);

    // P0：先经 test.run 登记宿主结果，再引用它 → 证据 status/summary/exitCode 全部来自宿主
    const create = byId.get('dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/e1' }, {}, {} as never);
    const test = byId.get('dev.test.run')!;
    const t = await test.execute({ worktreePath: '/repo/wt/e1', cmd: ['tsc', '--noEmit'] }, {}, {} as never);
    expect(t.resultId).toBeTruthy();
    const ev = await evAdd.execute(
      { orchestrationId: 'o1', stageId: 's1', resultId: t.resultId, worktreePath: '/repo/wt/e1' },
      {},
      {} as never,
    );
    expect(ev.evidenceId).toBeTruthy();
    expect(session.collector.records).toHaveLength(1);
    expect(session.collector.records[0].capturedBy).toBe('host');
    expect(session.collector.records[0].command).toBe('tsc --noEmit');
    // P1：跨 worktree 引用宿主结果 → 拒绝（证据不得跨任务/跨工作区）
    await expect(
      evAdd.execute(
        { orchestrationId: 'o2', stageId: 's2', resultId: t.resultId, worktreePath: '/repo/wt/other' },
        {},
        {} as never,
      ),
    ).rejects.toThrow(/不属于当前 worktree/);
    // P1：缺 worktreePath（无法验证作用域）→ 拒绝
    await expect(
      evAdd.execute({ orchestrationId: 'o2', stageId: 's2', resultId: t.resultId }, {}, {} as never),
    ).rejects.toThrow(/不属于当前 worktree/);

    // accept：只读宿主 collector 证据 + 宿主计算 changedProtectedPaths（不接受输入覆盖）
    const accept = byId.get('dev.accept')!;
    const rules = [{ id: 'typecheck', kind: 'test', command: 'tsc --noEmit' }];
    const ok = await accept.execute(
      { worktreePath: '/repo/wt/e1', rules },
      {},
      {} as never,
    );
    expect(ok.passed).toBe(true);
    // 伪造保护路径输入被忽略——宿主 gitChangedFiles 计算（fake 返回 docs/new.md，非 protected → 无触碰）
    expect(ok.changedProtectedPaths).toEqual([]);
  });

  it('dev.worktree.cleanup：未经宿主审批拒绝（节点参数无法伪造 confirm）；审批后清理', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t4' }, {}, {} as never);
    const cleanup = defs.find((d) => d.typeId === 'dev.worktree.cleanup')!;
    // P0：即使 params 有 confirm:true 也无效——审批只认宿主 approveCleanup
    const noApproval = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, { confirm: true }, {} as never);
    expect(noApproval.cleaned).toBe(false);
    expect(session.manager.isTracked('/repo/wt/t4')).toBe(true);
    // 宿主审批后清理
    session.approveCleanup('/repo/wt/t4');
    const approved = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, {}, {} as never);
    expect(approved.cleaned).toBe(true);
    expect(session.manager.isTracked('/repo/wt/t4')).toBe(false);
    // P1：审批一次性——清理成功后已消费，不可重复清理（重新登记新 worktree 也须重新审批）
    expect(session.isCleanupApproved('/repo/wt/t4')).toBe(false);
    await create.execute({ path: '/repo/wt/t5' }, {}, {} as never);
    const second = await cleanup.execute({ worktreePath: '/repo/wt/t5' }, {}, {} as never);
    expect(second.cleaned).toBe(false); // 未审批
    expect(session.manager.isTracked('/repo/wt/t5')).toBe(true);
  });

  it('P1：git.diff 无实际变更登记 failed——空 diff 不通过验收', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/d1' }, {}, {} as never);
    const diff = defs.find((d) => d.typeId === 'dev.git.diff')!;
    // fake runCommand 对 git diff 返回空 stdout（无改动）→ 登记 failed
    const r = (await diff.execute({ worktreePath: '/repo/wt/d1' }, {}, {} as never)) as {
      resultId: string;
    };
    expect(r.resultId).toBeTruthy();
    const rec = session.resultStore.get(r.resultId)!;
    expect(rec.status).toBe('failed');
    expect(rec.summary).toContain('空 diff');
  });
});
