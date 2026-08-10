import { describe, it, expect } from 'vitest';
import { mergeAgentPool } from './globalAgents';
import type { AgentConfig } from '../types';

const mk = (id: string, model: string): AgentConfig => ({
  id,
  name: id,
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  model,
});

describe('mergeAgentPool（项目级 ∪ 全局）', () => {
  it('项目级在前，全局在后（去重保留顺序）', () => {
    const merged = mergeAgentPool(
      [mk('a', 'A'), mk('b', 'B')],
      [mk('c', 'C'), mk('d', 'D')],
    );
    expect(merged.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('项目级同名(id)覆盖全局', () => {
    const merged = mergeAgentPool([mk('x', 'project')], [mk('x', 'global')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].model).toBe('project');
  });

  it('全局里独有的 agent 被保留（跨项目可复用）', () => {
    const merged = mergeAgentPool([mk('a', 'A')], [mk('g1', 'global'), mk('g2', 'global2')]);
    expect(merged.map((a) => a.id)).toEqual(['a', 'g1', 'g2']);
  });

  it('空项目 + 非空全局 → 全量来自全局', () => {
    const merged = mergeAgentPool([], [mk('g', 'global')]);
    expect(merged.map((a) => a.id)).toEqual(['g']);
  });
});
