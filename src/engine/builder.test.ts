import { describe, it, expect } from 'vitest';
import { resolveAgentForCategory } from './builder';
import type { AgentRouteTable } from '../types';

function table(partial: Partial<AgentRouteTable>): AgentRouteTable {
  return {
    ui: { agentId: 'agent-cheap', fallback: ['agent-fallback'] },
    logic: { agentId: 'agent-strong', fallback: ['agent-fallback'] },
    data: { agentId: 'agent-fallback' },
    ...partial,
  };
}

describe('resolveAgentForCategory（Builder 注入主 agent 阶段）', () => {
  it('类别命中：ui → 主 agent agent-cheap', () => {
    expect(resolveAgentForCategory('ui', table({}), 'agent-fallback')).toBe('agent-cheap');
  });

  it('类别命中：logic → 主 agent agent-strong', () => {
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback')).toBe('agent-strong');
  });

  it('类别缺失：未配置类别回退到 data 类别', () => {
    expect(resolveAgentForCategory('docs', table({}), 'agent-fallback')).toBe('agent-fallback');
  });

  it('类别未配置主 agent：落全局 fallbackAgentId', () => {
    expect(resolveAgentForCategory('logic', { data: {} }, 'agent-fallback')).toBe('agent-fallback');
  });

  it('类别与全局 fallback 均缺失：返回 undefined（不注入，worker 运行时自己决策）', () => {
    expect(resolveAgentForCategory('logic', { data: {} }, null)).toBeUndefined();
  });

  it('类别大小写不敏感匹配', () => {
    expect(resolveAgentForCategory('UI' as never, table({}), 'agent-fallback')).toBe('agent-cheap');
  });
});
