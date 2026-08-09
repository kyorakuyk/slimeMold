import { describe, it, expect } from 'vitest';
import { resolveAgentForCategory } from './builder';
import type { AgentRouteTable } from '../types';

const agents = [{ id: 'agent-cheap' }, { id: 'agent-strong' }, { id: 'agent-fallback' }];

function table(partial: Partial<AgentRouteTable>): AgentRouteTable {
  return {
    ui: { agentId: 'agent-cheap', fallback: ['agent-fallback'] },
    logic: { agentId: 'agent-strong', fallback: ['agent-fallback'] },
    data: { agentId: 'agent-fallback' },
    ...partial,
  };
}

describe('resolveAgentForCategory（Builder 注入阶段）', () => {
  it('类别命中：ui → 主 agent agent-cheap', () => {
    expect(resolveAgentForCategory('ui', table({}), 'agent-fallback', agents)).toBe('agent-cheap');
  });

  it('类别命中：logic → 主 agent agent-strong', () => {
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', agents)).toBe('agent-strong');
  });

  it('类别缺失：未配置类别回退到 data 类别', () => {
    // table 里未配 docs → 回退 routeTable['data'] = agent-fallback
    expect(resolveAgentForCategory('docs', table({}), 'agent-fallback', agents)).toBe('agent-fallback');
  });

  it('主 agent 缺失 → 走该行 fallback 链', () => {
    // agent-strong 已从 agents 中移除（等效被禁用/删除）
    const agentsNoStrong = agents.filter((a) => a.id !== 'agent-strong');
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', agentsNoStrong)).toBe(
      'agent-fallback',
    );
  });

  it('类别行 + 全局 fallback 均失效 → undefined（不注入，交运行时全局路由）', () => {
    expect(resolveAgentForCategory('logic', table({}), 'ghost', [])).toBeUndefined();
  });

  it('无 agents 列表时（未启用存在性过滤）直接返回主 agent', () => {
    // 兼容旧调用：未传 agents 不判断存在性
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', undefined)).toBe('agent-strong');
  });

  it('主 agent 存在但全局 fallback 指向缺失 agent 时，仍用主 agent', () => {
    expect(resolveAgentForCategory('ui', table({}), 'ghost', agents)).toBe('agent-cheap');
  });
});
