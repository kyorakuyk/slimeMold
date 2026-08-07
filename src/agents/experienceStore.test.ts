/**
 * 结构化经验库测试（阶段 E）。
 *
 * 覆盖：summarizeExperience 归约（失败/成功聚合/空）、addExperience 去重与持久化、
 * matchExperience 按 typeId 匹配、remove/clear、reset 测试隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addExperience,
  clearExperience,
  loadExperience,
  matchExperience,
  removeExperience,
  resetExperienceCache,
  summarizeExperience,
  type ExperienceEntry,
} from './experienceStore';

const entry = (p: Partial<ExperienceEntry>): ExperienceEntry => ({
  id: 'e1',
  typeId: 'ai.chat',
  wfId: 'wf1',
  runId: 1,
  outcome: 'success',
  summary: 's',
  insights: ['i'],
  at: 0,
  ...p,
});

describe('summarizeExperience 归约', () => {
  it('失败节点逐条沉淀 failure + 教训', () => {
    const out = summarizeExperience({
      projectId: 'p1',
      wfId: 'wf1',
      runId: 5,
      status: 'error',
      nodes: [
        { id: 'a', typeId: 'ai.chat', status: 'error', error: 'boom\nmore', label: '对话' },
        { id: 'b', typeId: 'input.text', status: 'success', durationMs: 10 },
      ],
    });
    const f = out.find((e) => e.outcome === 'failure');
    expect(f).toBeTruthy();
    expect(f!.typeId).toBe('ai.chat');
    expect(f!.insights[0]).toContain('失败原因：boom');
  });

  it('成功节点按 typeId 聚合，含平均耗时', () => {
    const out = summarizeExperience({
      projectId: 'p1',
      wfId: 'wf1',
      runId: 6,
      status: 'success',
      nodes: [
        { id: 'a', typeId: 'text.template', status: 'success', durationMs: 20 },
        { id: 'b', typeId: 'text.template', status: 'success', durationMs: 40 },
        { id: 'c', typeId: 'input.text', status: 'success', durationMs: 10 },
      ],
    });
    expect(out).toHaveLength(2);
    const tpl = out.find((e) => e.typeId === 'text.template')!;
    expect(tpl.outcome).toBe('success');
    expect(tpl.summary).toContain('×2');
    expect(tpl.insights[0]).toContain('平均耗时 30');
  });

  it('无节点时不产出', () => {
    expect(
      summarizeExperience({ projectId: 'p1', wfId: 'w', runId: 1, status: 'success', nodes: [] }),
    ).toHaveLength(0);
  });
});

describe('addExperience / loadExperience / matchExperience', () => {
  beforeEach(() => {
    resetExperienceCache();
    clearExperience('p1');
    clearExperience('p2');
  });

  it('追加 + 持久化（重载缓存后仍可取回）', () => {
    expect(addExperience('p1', entry({ id: 'e1', typeId: 'ai.chat' }))).toBe(true);
    // 同 typeId+runId 去重
    expect(addExperience('p1', entry({ id: 'e2', typeId: 'ai.chat' }))).toBe(false);
    resetExperienceCache(); // 模拟刷新
    expect(loadExperience('p1')).toHaveLength(1);
  });

  it('matchExperience 按 typeId 过滤，返回最新 N 条', () => {
    addExperience('p1', entry({ id: 'e1', typeId: 'ai.chat', runId: 1, insights: ['老'] }));
    addExperience('p1', entry({ id: 'e2', typeId: 'ai.chat', runId: 2, insights: ['新'] }));
    addExperience('p1', entry({ id: 'e3', typeId: 'worker.implementer', runId: 2 }));
    const hits = matchExperience('p1', 'ai.chat');
    expect(hits).toHaveLength(2);
    expect(hits[0]!.insights[0]).toBe('新'); // 最新在前
    expect(matchExperience('p1', 'ghost')).toHaveLength(0);
    // 不同项目隔离
    expect(matchExperience('p2', 'ai.chat')).toHaveLength(0);
  });

  it('removeExperience / clearExperience', () => {
    addExperience('p1', entry({ id: 'e1' }));
    expect(removeExperience('p1', 'e1')).toBe(true);
    expect(removeExperience('p1', 'ghost')).toBe(false);
    addExperience('p1', entry({ id: 'e2' }));
    clearExperience('p1');
    expect(loadExperience('p1')).toHaveLength(0);
  });
});
