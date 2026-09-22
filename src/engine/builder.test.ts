import { describe, it, expect } from 'vitest';
import { resolveAgentForCategory, buildConstructionWorkflow } from './builder';
import type { AgentRouteTable } from '../types/dispatch';

const agents = [{ id: 'agent-cheap' }, { id: 'agent-strong' }, { id: 'agent-fallback' }];

function table(partial: Partial<AgentRouteTable>): AgentRouteTable {
  return {
    ui: { agentId: 'agent-cheap', fallback: ['agent-fallback'] },
    logic: { agentId: 'agent-strong', fallback: ['agent-fallback'] },
    data: { agentId: 'agent-fallback' },
    ...partial,
  };
}

describe('resolveAgentForCategory（Builder 注入 + 主 agent 缺失补位）', () => {
  it('类别命中：ui → 主 agent agent-cheap', () => {
    expect(resolveAgentForCategory('ui', table({}), 'agent-fallback', agents)).toBe('agent-cheap');
  });

  it('类别命中：logic → 主 agent agent-strong', () => {
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', agents)).toBe('agent-strong');
  });

  it('类别缺失：未配置类别回退到 data 类别', () => {
    expect(resolveAgentForCategory('docs', table({}), 'agent-fallback', agents)).toBe('agent-fallback');
  });

  it('主 agent 已被删除/禁用 → 注入该行 fallback 补位 agent', () => {
    // agent-strong 从 agents 中移除（等效被删除/禁用）
    const agentsNoStrong = agents.filter((a) => a.id !== 'agent-strong');
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', agentsNoStrong)).toBe(
      'agent-fallback',
    );
  });

  it('主 agent 缺失且该行 fallback 也缺失 → 落全局 fallbackAgentId', () => {
    const agentsNoStrong = agents.filter((a) => a.id !== 'agent-strong');
    // logic 行主 agent 缺失，fallback 指向不存在的 id → 落全局
    const t = { ...table({}), logic: { agentId: 'agent-strong', fallback: ['ghost'] } };
    expect(resolveAgentForCategory('logic', t, 'agent-cheap', agentsNoStrong)).toBe('agent-cheap');
  });

  it('类别行 + 全局 fallback 均失效 → undefined（不注入，交 worker 运行时）', () => {
    expect(resolveAgentForCategory('logic', { data: { agentId: 'ghost' } }, 'ghost', [])).toBeUndefined();
  });

  it('未传 agents 列表时不判断存在性，直接返回主 agent（兼容旧调用）', () => {
    expect(resolveAgentForCategory('logic', table({}), 'agent-fallback', undefined)).toBe('agent-strong');
  });

  it('类别大小写不敏感匹配', () => {
    expect(resolveAgentForCategory('UI' as never, table({}), 'agent-fallback', agents)).toBe('agent-cheap');
  });
});

describe('buildConstructionWorkflow（施工方工作流交付落盘）', () => {
  const modules = [
    { name: 'api', category: 'ui' as const, responsibility: '对外接口层', scope: ['src/api'], index: 0 },
    { name: 'core', category: 'logic' as const, responsibility: '核心逻辑', scope: ['src/core'], index: 1 },
  ];

  it('交付节点 pipeline.handoff 默认开启直接落盘（writeOut=on）', () => {
    const wf = buildConstructionWorkflow({
      modules,
      routeTable: table({}),
      fallbackAgentId: 'agent-fallback',
      agents,
    });
    const handoff = wf.nodes.find((n) => n.typeId === 'pipeline.handoff');
    expect(handoff).toBeDefined();
    expect(handoff!.params.writeOut).toBe('on');
    expect(handoff!.params.outDir).toBe('deliverables');
    expect(handoff!.params.outFile).toBe('construction-project.md');
  });

  it('交付 payload 接 coord.resolver.merged（真实项目代码），而非 validator.report', () => {
    const wf = buildConstructionWorkflow({
      modules,
      routeTable: table({}),
      fallbackAgentId: 'agent-fallback',
      agents,
    });
    const handoff = wf.nodes.find((n) => n.typeId === 'pipeline.handoff');
    const resolver = wf.nodes.find((n) => n.typeId === 'coord.resolver');
    const e = wf.edges.find((e) => e.target === handoff!.id && e.targetHandle === 'payload');
    expect(e?.source).toBe(resolver!.id);
    expect(e?.sourceHandle).toBe('merged');
  });
});
