import { describe, it, expect } from 'vitest';
import {
  EvidenceCollector,
  createJsonlEvidenceStore,
  createHostEvidenceStore,
  evidencePathFor,
} from './evidence';

describe('H4 EvidenceCollector', () => {
  it('add 强制 capturedBy=host，并补齐 id/createdAt', () => {
    const c = new EvidenceCollector();
    const rec = c.add({
      orchestrationId: 'o1',
      stageId: 's1',
      kind: 'test',
      status: 'passed',
      exitCode: 0,
      summary: 'vitest 全绿',
    });
    expect(rec.capturedBy).toBe('host');
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeTruthy();
    // 即使输入伪造 capturedBy，也强制覆盖（类型不允许非 host，测试经 unknown 绕过类型检查）
    const fake = c.add({
      orchestrationId: 'o1',
      stageId: 's1',
      kind: 'test',
      status: 'passed',
      summary: 'x',
      capturedBy: 'agent',
    } as unknown as Parameters<EvidenceCollector['add']>[0]);
    expect(fake.capturedBy).toBe('host');
  });

  it('byStage 过滤、toJSON 快照、clear 清空', () => {
    const c = new EvidenceCollector();
    c.add({ orchestrationId: 'o1', stageId: 'a', kind: 'diff', status: 'passed', summary: 'd1' });
    c.add({ orchestrationId: 'o1', stageId: 'b', kind: 'diff', status: 'passed', summary: 'd2' });
    expect(c.byStage('a')).toHaveLength(1);
    const snap = c.toJSON();
    expect(snap).toHaveLength(2);
    c.clear();
    expect(c.records).toHaveLength(0);
  });

  it('P1 持久化：JSONL store 落盘 + loadPersisted 跨会话恢复', async () => {
    const tmp = `evidence-test-${Date.now()}.jsonl`;
    const store = createJsonlEvidenceStore(tmp);
    const c1 = new EvidenceCollector(store);
    c1.add({ orchestrationId: 'o1', stageId: 's1', kind: 'test', status: 'passed', exitCode: 0, summary: 'first' });
    c1.add({ orchestrationId: 'o1', stageId: 's2', kind: 'diff', status: 'passed', summary: 'second' });
    // 等待 fire-and-forget 落盘完成
    await new Promise((r) => setTimeout(r, 30));
    // 新 collector 从同一 store 恢复（模拟重启）
    const c2 = new EvidenceCollector(store);
    const loaded = await c2.loadPersisted();
    expect(loaded).toHaveLength(2);
    expect(loaded.every((r) => r.capturedBy === 'host')).toBe(true);
    expect(c2.records).toHaveLength(2);
    // 清理临时文件
    const { unlink } = await import('node:fs/promises');
    await unlink(tmp).catch(() => {});
  });

  it('审计：evidencePathFor 拒绝路径逃逸 key；flush/addAsync 等待落盘确认', async () => {
    // 路径约束：合法 key → <baseDir>/<key>.jsonl；非法 key（分隔符/..）→ 抛错
    expect(evidencePathFor('/data/evidence', 'orch-20260812')).toBe('/data/evidence/orch-20260812.jsonl');
    expect(() => evidencePathFor('/data/evidence', '../etc/passwd')).toThrow(/非法证据存储 key/);
    expect(() => evidencePathFor('/data/evidence', 'a/b')).toThrow(/非法证据存储 key/);
    expect(() => evidencePathFor('/data/evidence', 'a\\b')).toThrow(/非法证据存储 key/);

    // P1：baseDir 与 worktree 相交 → 拒（EvidenceStore 必须在 worktree 外）
    expect(() => createHostEvidenceStore('/repo/worktree', '/repo/worktree', 'k')).toThrow(/worktree 之外/);
    expect(() => createHostEvidenceStore('/repo/worktree/.slimemold/evidence', '/repo/worktree', 'k')).toThrow(/worktree 之外/);
    expect(() => createHostEvidenceStore('/repo', '/repo/worktree', 'k')).toThrow(/worktree 之外/); // evidence 根是 worktree 祖先
    // 合法：evidence 根在 worktree 外且不相交 → 返回持久化实例
    const ok = createHostEvidenceStore('/repo/.slimemold/evidence', '/repo/worktree', 'k1');
    expect(typeof ok.append).toBe('function');
    expect(typeof ok.load).toBe('function');

    // addAsync 等待落盘；flush 在落盘失败时 throw
    const tmp = `evidence-flush-${Date.now()}.jsonl`;
    const store = createJsonlEvidenceStore(tmp);
    const c = new EvidenceCollector(store);
    await c.addAsync({ orchestrationId: 'o1', stageId: 's1', kind: 'test', status: 'passed', exitCode: 0, summary: 'sync' });
    await c.flush(); // 无失败 → 不抛
    expect(c.records).toHaveLength(1);

    // 落盘失败（写不可用路径）→ flush throw（含证据 id 与失败原因），验收据此拒绝
    const badStore = createJsonlEvidenceStore('/no/such/dir/evidence.jsonl');
    const c2 = new EvidenceCollector(badStore);
    c2.add({ orchestrationId: 'o1', stageId: 's1', kind: 'test', status: 'passed', summary: 'x' });
    await expect(c2.flush()).rejects.toThrow(/证据.*落盘失败/);

    const { unlink } = await import('node:fs/promises');
    await unlink(tmp).catch(() => {});
  });
});
