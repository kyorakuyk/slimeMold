import { describe, it, expect } from 'vitest';
import { createDevNodeDefs } from './index';
import type { DevSession } from '../../dev/session';
import { WorktreeManager } from '../../dev/worktree';
import { createNodeDevService, type NodeDevDeps } from '../../dev/capabilities';
import { defaultDevPolicy } from '../../dev/policy';
import { EvidenceCollector, type EvidencePersistence } from '../../dev/evidence';
import type { CommandResult } from '../../dev/node-run';

/** 内存持久化（测试默认注入：forceCleanup 要求宿主持久化，无则拒绝）。 */
function memPersistence(): EvidencePersistence {
  const mem: import('../../dev/evidence').EvidenceRecord[] = [];
  return {
    append: async (rec) => {
      mem.push(rec);
    },
    load: async () => [...mem],
  };
}

function fakeSession(opts: {
  failGitStatus?: boolean;
  failAudit?: boolean;
  noPersistence?: boolean;
  failWorktreeAdd?: boolean;
} = {}): DevSession {
  const git = async (args: string[], _cwd: string): Promise<CommandResult> => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '', durationMs: 1 };
    if (args[0] === 'worktree') {
      // 模拟残留 worktree 冲突：git worktree add 返回 128（manager.create → null）
      if (opts.failWorktreeAdd) {
        return { exitCode: 128, stdout: '', stderr: 'fatal: ... already exists', durationMs: 1 };
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    }
    if (args[0] === 'ls-files') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
  };
  const manager = new WorktreeManager({ git }, '/repo');
  const registry = { isTracked: (cwd: string) => manager.isTracked(cwd) };
  const files = new Map<string, string>([['src/components/A.tsx', 'export const a = 1;\n']]);
  const deps: NodeDevDeps = {
    runCommand: async (cmd, args) => {
      if (cmd === 'git') {
        if (args[0] === 'status' && opts.failGitStatus) {
          return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', durationMs: 1 };
        }
        if (args[0] === 'diff' && args.includes('--name-only')) {
          return { exitCode: 0, stdout: 'docs/new.md\n', stderr: '', durationMs: 1 };
        }
        if (args[0] === 'diff') {
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        }
        if (args[0] === 'ls-files') return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        return { exitCode: 0, stdout: ' M src/components/A.tsx\n', stderr: '', durationMs: 1 };
      }
      return { exitCode: 0, stdout: 'PASS', stderr: '', durationMs: 1 };
    },
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
  const collector = new EvidenceCollector(
    opts.failAudit
      ? {
          append: async () => {
            throw new Error('audit disk full');
          },
          load: async () => [],
        }
      : opts.noPersistence
        ? undefined
        : memPersistence(),
  );
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  let accSeq = 0;
  const session: DevSession = {
    policy: defaultDevPolicy,
    manager,
    service,
    collector,
    resultStore: new Map(),
    acceptanceStore: new Map(),
    approvedCleanups: new Map(),
    confirmCleanupInFlight: new Set(),
    defs: [],
    registerResult(rec) {
      if (!rec.resultId || !rec.worktreePath || !rec.orchestrationId || !rec.stageId) {
        throw new Error('作用域必填');
      }
      this.resultStore.set(rec.resultId, rec);
      return rec;
    },
    nextAcceptanceId() {
      accSeq += 1;
      return `acc-${Date.now().toString(36)}-${accSeq}`;
    },
    recordAcceptance(rec) {
      if (this.acceptanceStore.has(rec.acceptanceId)) {
        throw new Error(`验收记录 ID 已存在，禁止覆盖：${rec.acceptanceId}`);
      }
      this.acceptanceStore.set(rec.acceptanceId, rec);
      return rec;
    },
    persistAcceptance: async () => {},
    loadAcceptances: async () => {},
    getAcceptance(id) {
      return this.acceptanceStore.get(id);
    },
    async computeWorktreeSignature(path) {
      return `sig-${norm(path)}`;
    },
    approveCleanup(path, opts) {
      const key = norm(path);
      this.approvedCleanups.set(key, {
        worktreePath: key,
        baseRevision: opts?.baseRevision,
        stateSignature: opts?.stateSignature,
        acceptanceId: opts?.acceptanceId,
        orchestrationId: opts?.orchestrationId,
        stageId: opts?.stageId,
        approvedAt: '2026-01-01T00:00:00.000Z',
        consumed: false,
      });
    },
    isCleanupApproved(path) {
      const a = this.approvedCleanups.get(norm(path));
      return !!a && !a.consumed;
    },
    getCleanupApproval(path) {
      return this.approvedCleanups.get(norm(path));
    },
    consumeCleanup(path) {
      const key = norm(path);
      const a = this.approvedCleanups.get(key);
      if (a) this.approvedCleanups.set(key, { ...a, consumed: true });
    },
    async forceCleanup(path, reason) {
      // P1（审计）：无宿主持久化 → 直接拒绝（审计必须落盘可追溯）
      if (!this.collector.hasPersistence()) {
        throw new Error('forceCleanup 需要宿主持久化（EvidenceStore）');
      }
      if (!reason.trim()) throw new Error('forceCleanup 必须提供 reason');
      const key = norm(path);
      if (this.confirmCleanupInFlight.has(key)) return false;
      this.confirmCleanupInFlight.add(key);
      try {
        // P1：审计落盘失败 → 拒绝清理（addAsync 失败 throw）
        await this.collector.addAsync({
          orchestrationId: 'host',
          stageId: 'force-cleanup',
          worktreePath: key,
          kind: 'path-policy',
          status: 'failed',
          summary: `forceCleanup: ${reason}`,
        });
        return manager.cleanup(path, { confirm: true });
      } finally {
        this.confirmCleanupInFlight.delete(key);
      }
    },
    async confirmAndCleanup(path) {
      const key = norm(path);
      if (this.confirmCleanupInFlight.has(key)) return false;
      this.confirmCleanupInFlight.add(key);
      try {
        const approval = this.approvedCleanups.get(key);
        const info = manager.get(path);
        if (!approval || approval.consumed) return false;
        if (!approval.acceptanceId || !approval.stateSignature || !approval.baseRevision) return false;
        const acc = this.acceptanceStore.get(approval.acceptanceId);
        const accOk =
          !!acc &&
          acc.passed &&
          acc.orchestrationId === approval.orchestrationId &&
          acc.stageId === approval.stageId &&
          norm(acc.worktreePath) === key;
        const revOk = info?.baseRevision === approval.baseRevision;
        const sigOk = `sig-${key}` === approval.stateSignature;
        if (!accOk || !revOk || !sigOk) return false;
        const cleaned = await manager.cleanup(path, { confirm: true });
        if (cleaned) this.consumeCleanup(path);
        return cleaned;
      } finally {
        this.confirmCleanupInFlight.delete(key);
      }
    },
  };
  return session;
}

/** 完整三绑定审批（acceptanceId + stateSignature + baseRevision），并登记通过验收。 */
async function approveFull(
  session: DevSession,
  path: string,
  acc: { orchestrationId: string; stageId: string; passed?: boolean; wtOverride?: string },
): Promise<void> {
  const wt = acc.wtOverride ?? path;
  const acceptanceId = session.nextAcceptanceId();
  session.recordAcceptance({
    acceptanceId,
    orchestrationId: acc.orchestrationId,
    stageId: acc.stageId,
    worktreePath: wt,
    passed: acc.passed ?? true,
    failedChecks: [],
    at: '2026-01-01T00:00:00.000Z',
  });
  session.approveCleanup(path, {
    acceptanceId,
    orchestrationId: acc.orchestrationId,
    stageId: acc.stageId,
    stateSignature: `sig-${path.replace(/\\/g, '/').replace(/\/+$/, '')}`,
    baseRevision: 'abc123',
  });
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

  it('dev.code.patch：应用受控补丁 + 内容哈希 + 缺失作用域拒', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t2' }, {}, {} as never);
    const patch = defs.find((d) => d.typeId === 'dev.code.patch')!;
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
    const r = await patch.execute(
      { worktreePath: '/repo/wt/t2', path: 'src/components/A.tsx', patch: diff, orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    expect(r.ok).toBe(true);
    expect(r.contentHash).toBeTruthy();
    expect(r.resultId).toBeTruthy();
    await expect(
      patch.execute({ worktreePath: '/repo/wt/t2', path: 'src/components/A.tsx', patch: diff }, {}, {} as never),
    ).rejects.toThrow(/orchestrationId 与 stageId/);
  });

  it('dev.shell.run：白名单放行/拒绝；dev.test.run 捕获退出码', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t3' }, {}, {} as never);
    const shell = defs.find((d) => d.typeId === 'dev.shell.run')!;
    const okRun = await shell.execute(
      { worktreePath: '/repo/wt/t3', cmd: ['git', 'status', '--porcelain'], orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    expect(okRun.exitCode).toBe(0);
    const badRun = await shell.execute(
      { worktreePath: '/repo/wt/t3', cmd: ['git', 'push'], orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    expect(badRun.exitCode).toBe(-1);
    const test = defs.find((d) => d.typeId === 'dev.test.run')!;
    const t = await test.execute(
      { worktreePath: '/repo/wt/t3', cmd: ['tsc', '--noEmit'], orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    expect(t.exitCode).toBe(0);
    expect(t.resultId).toBeTruthy();
    await expect(
      test.execute({ worktreePath: '/repo/wt/t3', cmd: ['tsc', '--noEmit'] }, {}, {} as never),
    ).rejects.toThrow(/orchestrationId 与 stageId/);
  });

  it('dev.evidence.add → dev.accept：宿主结果引用 + 三重作用域 + 只读宿主证据', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const byId = new Map(defs.map((d) => [d.typeId, d]));
    const evAdd = byId.get('dev.evidence.add')!;
    await expect(
      evAdd.execute({ orchestrationId: 'o1', stageId: 's1', resultId: 'fake' }, {}, {} as never),
    ).rejects.toThrow(/宿主结果不存在/);

    const create = byId.get('dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/e1' }, {}, {} as never);
    const test = byId.get('dev.test.run')!;
    const t = await test.execute(
      { worktreePath: '/repo/wt/e1', cmd: ['tsc', '--noEmit'], orchestrationId: 'o1', stageId: 's1' },
      {},
      {} as never,
    );
    const ev = await evAdd.execute(
      { orchestrationId: 'o1', stageId: 's1', resultId: t.resultId, worktreePath: '/repo/wt/e1' },
      {},
      {} as never,
    );
    expect(ev.evidenceId).toBeTruthy();
    expect(session.collector.records).toHaveLength(1);
    expect(session.collector.records[0].capturedBy).toBe('host');
    await expect(
      evAdd.execute(
        { orchestrationId: 'o2', stageId: 's2', resultId: t.resultId, worktreePath: '/repo/wt/other' },
        {},
        {} as never,
      ),
    ).rejects.toThrow(/不属于当前 worktree/);
    await expect(
      evAdd.execute(
        { orchestrationId: 'o2', stageId: 's1', resultId: t.resultId, worktreePath: '/repo/wt/e1' },
        {},
        {} as never,
      ),
    ).rejects.toThrow(/不属于当前编排/);
    await expect(
      evAdd.execute(
        { orchestrationId: 'o1', stageId: 's2', resultId: t.resultId, worktreePath: '/repo/wt/e1' },
        {},
        {} as never,
      ),
    ).rejects.toThrow(/不属于当前阶段/);

    const accept = byId.get('dev.accept')!;
    const rules = [{ id: 'typecheck', kind: 'test', command: 'tsc --noEmit' }];
    const ok = await accept.execute(
      { orchestrationId: 'o1', stageId: 's1', worktreePath: '/repo/wt/e1', rules },
      {},
      {} as never,
    );
    expect(ok.passed).toBe(true);
    expect(ok.acceptanceId).toBeTruthy();
    const acc = session.getAcceptance(ok.acceptanceId as string);
    expect(acc).toBeDefined();
    expect(acc!.passed).toBe(true);
    expect(acc!.worktreePath).toBe('/repo/wt/e1');
    expect(ok.changedProtectedPaths).toEqual([]);
    const otherStage = await accept.execute(
      { orchestrationId: 'o1', stageId: 's9', worktreePath: '/repo/wt/e1', rules },
      {},
      {} as never,
    );
    expect(otherStage.passed).toBe(false);
  });

  it('dev.worktree.cleanup：无审批拒 / 仅审批无绑定拒 / 三绑定齐全才清理 / 一次性消费', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/t4' }, {}, {} as never);
    const cleanup = defs.find((d) => d.typeId === 'dev.worktree.cleanup')!;
    const noApproval = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, {}, {} as never);
    expect(noApproval.cleaned).toBe(false);
    // P1（审计）：仅 approve 而无绑定 → 拒
    session.approveCleanup('/repo/wt/t4');
    const noBind = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, {}, {} as never);
    expect(noBind.cleaned).toBe(false);
    // 三绑定齐全 → 清理
    await approveFull(session, '/repo/wt/t4', { orchestrationId: 'o', stageId: 's' });
    const approved = await cleanup.execute({ worktreePath: '/repo/wt/t4' }, {}, {} as never);
    expect(approved.cleaned).toBe(true);
    expect(session.manager.isTracked('/repo/wt/t4')).toBe(false);
    expect(session.isCleanupApproved('/repo/wt/t4')).toBe(false);
  });

  it('cleanup：绑定 acceptance 四态（无记录/failed/跨 worktree/passed）', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/c1' }, {}, {} as never);
    const cleanup = defs.find((d) => d.typeId === 'dev.worktree.cleanup')!;
    // 无记录 → 拒
    session.approveCleanup('/repo/wt/c1', {
      acceptanceId: 'acc-none',
      orchestrationId: 'o',
      stageId: 's',
      stateSignature: 'sig-/repo/wt/c1',
      baseRevision: 'abc123',
    });
    let r = await cleanup.execute({ worktreePath: '/repo/wt/c1' }, {}, {} as never);
    expect(r.cleaned).toBe(false);
    // failed → 拒
    await approveFull(session, '/repo/wt/c1', { orchestrationId: 'o', stageId: 's', passed: false });
    r = await cleanup.execute({ worktreePath: '/repo/wt/c1' }, {}, {} as never);
    expect(r.cleaned).toBe(false);
    // passed 但 worktreePath 不一致 → 拒
    await approveFull(session, '/repo/wt/c1', { orchestrationId: 'o', stageId: 's', wtOverride: '/repo/wt/other' });
    r = await cleanup.execute({ worktreePath: '/repo/wt/c1' }, {}, {} as never);
    expect(r.cleaned).toBe(false);
    // passed + 一致 → 清理
    await approveFull(session, '/repo/wt/c1', { orchestrationId: 'o', stageId: 's' });
    r = await cleanup.execute({ worktreePath: '/repo/wt/c1' }, {}, {} as never);
    expect(r.cleaned).toBe(true);
  });

  it('cleanup：stateSignature 不一致拒 / 基线不匹配拒', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/s1' }, {}, {} as never);
    const cleanup = defs.find((d) => d.typeId === 'dev.worktree.cleanup')!;
    const sig = 'sig-/repo/wt/s1';
    const mkAcc = () => {
      const acceptanceId = session.nextAcceptanceId();
      session.recordAcceptance({
        acceptanceId,
        orchestrationId: 'o',
        stageId: 's',
        worktreePath: '/repo/wt/s1',
        passed: true,
        failedChecks: [],
        at: '',
      });
      return acceptanceId;
    };
    // 错误签名 → 拒
    session.approveCleanup('/repo/wt/s1', {
      acceptanceId: mkAcc(),
      orchestrationId: 'o',
      stageId: 's',
      stateSignature: 'wrong-sig',
      baseRevision: 'abc123',
    });
    let r = await cleanup.execute({ worktreePath: '/repo/wt/s1' }, {}, {} as never);
    expect(r.cleaned).toBe(false);
    // 基线不匹配 → 拒
    session.approveCleanup('/repo/wt/s1', {
      acceptanceId: mkAcc(),
      orchestrationId: 'o',
      stageId: 's',
      stateSignature: sig,
      baseRevision: 'rev-a',
    });
    r = await cleanup.execute({ worktreePath: '/repo/wt/s1' }, {}, {} as never);
    expect(r.cleaned).toBe(false);
    // 全绑定正确 → 清理
    session.approveCleanup('/repo/wt/s1', {
      acceptanceId: mkAcc(),
      orchestrationId: 'o',
      stageId: 's',
      stateSignature: sig,
      baseRevision: 'abc123',
    });
    r = await cleanup.execute({ worktreePath: '/repo/wt/s1' }, {}, {} as never);
    expect(r.cleaned).toBe(true);
  });

  it('P1（审计）：accept 二次执行产生新 acceptanceId（不覆盖旧记录）', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const byId = new Map(defs.map((d) => [d.typeId, d]));
    const create = byId.get('dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/a1' }, {}, {} as never);
    const test = byId.get('dev.test.run')!;
    const t = await test.execute(
      { worktreePath: '/repo/wt/a1', cmd: ['tsc', '--noEmit'], orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    const evAdd = byId.get('dev.evidence.add')!;
    await evAdd.execute(
      { orchestrationId: 'o', stageId: 's', resultId: t.resultId, worktreePath: '/repo/wt/a1' },
      {},
      {} as never,
    );
    const accept = byId.get('dev.accept')!;
    const rules = [{ id: 'typecheck', kind: 'test', command: 'tsc --noEmit' }];
    const a1 = await accept.execute(
      { orchestrationId: 'o', stageId: 's', worktreePath: '/repo/wt/a1', rules },
      {},
      {} as never,
    );
    const a2 = await accept.execute(
      { orchestrationId: 'o', stageId: 's', worktreePath: '/repo/wt/a1', rules },
      {},
      {} as never,
    );
    expect(a1.acceptanceId).not.toBe(a2.acceptanceId);
    expect(session.acceptanceStore.size).toBe(2);
    // 两条记录都保留（未被覆盖）
    expect(session.getAcceptance(a1.acceptanceId as string)!.passed).toBe(true);
    expect(session.getAcceptance(a2.acceptanceId as string)!.passed).toBe(true);
  });

  it('P1：git.diff 无实际变更登记 failed——空 diff 不通过验收', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/d1' }, {}, {} as never);
    const diff = defs.find((d) => d.typeId === 'dev.git.diff')!;
    const r = (await diff.execute(
      { worktreePath: '/repo/wt/d1', orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    )) as {
      resultId: string;
    };
    expect(r.resultId).toBeTruthy();
    const rec = session.resultStore.get(r.resultId)!;
    expect(rec.status).toBe('failed');
    expect(rec.summary).toContain('空 diff');
  });

  it('P1：git.status 失败时登记 failed（按 exitCode 判定）', async () => {
    const session = fakeSession({ failGitStatus: true });
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/g1' }, {}, {} as never);
    const gitStatus = defs.find((d) => d.typeId === 'dev.git.status')!;
    const ok = await gitStatus.execute(
      { worktreePath: '/repo/wt/g1', orchestrationId: 'o', stageId: 's' },
      {},
      {} as never,
    );
    const rec = session.resultStore.get(ok.resultId as string)!;
    expect(rec.status).toBe('failed');
    expect(rec.exitCode).toBe(128);
  });

  it('P1：confirmAndCleanup 宿主互斥——并发确认同一 worktree 只执行一次清理', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/m1' }, {}, {} as never);
    // 三绑定审批
    await approveFull(session, '/repo/wt/m1', { orchestrationId: 'o', stageId: 's' });
    // 模拟并发：先占用锁
    session.confirmCleanupInFlight.add('/repo/wt/m1');
    const blocked = await session.confirmAndCleanup('/repo/wt/m1');
    expect(blocked).toBe(false); // 锁占用 → 拒绝
    session.confirmCleanupInFlight.delete('/repo/wt/m1');
    // 释放锁后正常清理
    const ok = await session.confirmAndCleanup('/repo/wt/m1');
    expect(ok).toBe(true);
    expect(session.manager.isTracked('/repo/wt/m1')).toBe(false);
  });

  it('P1：worktree.create 失败（残留 worktree 冲突）→ 显式抛错，不静默 success', async () => {
    const session = fakeSession({ failWorktreeAdd: true });
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    // git worktree add 返回 128 → manager.create 返回 null → 节点必须抛错（fail-closed）
    await expect(create.execute({ path: '/repo/wt/residue' }, {}, {} as never)).rejects.toThrow(
      /worktree\.create 失败/,
    );
    // 未登记 → 后续节点 fail-closed 也报「不属于已登记 worktree」，但 create 根因已可见
    expect(session.manager.isTracked('/repo/wt/residue')).toBe(false);
  });

  it('P2：forceCleanup 审计落盘——reason 写入宿主证据', async () => {
    const session = fakeSession();
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/f1' }, {}, {} as never);
    const cleaned = await session.forceCleanup('/repo/wt/f1', '人工强制清理：验收阻塞');
    expect(cleaned).toBe(true);
    // 审计证据已落盘
    const audit = session.collector.records.find((r) => r.stageId === 'force-cleanup');
    expect(audit).toBeDefined();
    expect(audit!.capturedBy).toBe('host');
    expect(audit!.summary).toContain('人工强制清理');
    // 无 reason → 抛错
    await expect(session.forceCleanup('/repo/wt/f1', '')).rejects.toThrow(/reason/);
  });

  it('P1：forceCleanup 审计落盘失败 → 拒绝清理（不删除 worktree）', async () => {
    const session = fakeSession({ failAudit: true });
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/f2' }, {}, {} as never);
    // addAsync 落盘失败 → forceCleanup 抛错，worktree 保留
    await expect(session.forceCleanup('/repo/wt/f2', '审计不可用')).rejects.toThrow(/audit disk full/);
    expect(session.manager.isTracked('/repo/wt/f2')).toBe(true);
  });

  it('P1：forceCleanup 无宿主持久化 → 拒绝清理（审计必须落盘可追溯）', async () => {
    const session = fakeSession({ noPersistence: true });
    const defs = createDevNodeDefs(session);
    const create = defs.find((d) => d.typeId === 'dev.worktree.create')!;
    await create.execute({ path: '/repo/wt/f3' }, {}, {} as never);
    // 未注入宿主持久化（内存态）→ forceCleanup 抛错，worktree 保留
    await expect(session.forceCleanup('/repo/wt/f3', '无持久化场景')).rejects.toThrow(/宿主持久化/);
    expect(session.manager.isTracked('/repo/wt/f3')).toBe(true);
  });
});
