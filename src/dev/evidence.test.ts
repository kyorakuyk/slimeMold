import { describe, it, expect } from 'vitest';
import { EvidenceCollector, createJsonlEvidenceStore } from './evidence';

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
});
