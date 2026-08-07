/**
 * AgentRouter 决策层单元测试（阶段 B）。
 *
 * 覆盖：显式绑定优先、显式缺失逐级兜底（类别路由→fallback 链→项目默认→首个）、
 * 无 agent 抛错、候选链生成、复杂度分档、RunContext 特征并入。
 */
import { describe, it, expect } from 'vitest';
import { estimateTier, resolveAgent, candidateChain, resolveAgentForRunContext } from './agentRouter';
import type { AgentConfig, AgentRouteTable } from '../types';

const ag = (id: string, model = 'm1'): AgentConfig =>
  ({ id, name: id, protocol: 'openai', baseUrl: 'http://x', model } as AgentConfig);

describe('estimateTier 复杂度分档', () => {
  it('按文本长度与影响域大小分档', () => {
    expect(estimateTier({})).toBe('light');
    expect(estimateTier({ textLength: 100 })).toBe('light');
    expect(estimateTier({ textLength: 2000 })).toBe('standard');
    expect(estimateTier({ scopeSize: 4 })).toBe('standard');
    expect(estimateTier({ textLength: 8000 })).toBe('heavy');
    expect(estimateTier({ scopeSize: 12 })).toBe('heavy');
    expect(estimateTier({ scopeSize: 30, textLength: 0 })).toBe('heavy');
  });
});

describe('resolveAgent 决策优先级', () => {
  const env = {
    agents: [ag('a1', 'model-a'), ag('a2', 'model-b'), ag('a3', 'model-c')],
    routeTable: {
      ui: { agentId: 'a2', fallback: ['a3', 'a1'] },
      logic: { agentId: 'missing-agent', fallback: ['a3', 'a1'] },
    } as AgentRouteTable,
    defaultAgentId: 'a3',
  };

  it('显式 agentId 存在时直接用，不查路由', () => {
    const d = resolveAgent({ agentId: 'a1', category: 'ui' }, env);
    expect(d.agent.id).toBe('a1');
    expect(d.reason).toBe('explicit');
    expect(d.routed).toBe(false);
    expect(d.tier).toBe('light');
  });

  it('无显式绑定：按 category 走路由表', () => {
    const d = resolveAgent({ category: 'ui' }, env);
    expect(d.agent.id).toBe('a2');
    expect(d.reason).toBe('route-category');
    expect(d.routed).toBe(true);
  });

  it('category 路由表主 agent 缺失（missing-agent）时走 fallback 链', () => {
    const d = resolveAgent({ category: 'logic' }, env);
    expect(d.agent.id).toBe('a3'); // fallback ['a3','a1'] 第一个可用
    expect(d.reason).toBe('route-fallback');
    expect(d.routed).toBe(true);
  });

  it('无 category 匹配时走项目默认 agent', () => {
    const d = resolveAgent({}, env);
    expect(d.agent.id).toBe('a3');
    expect(d.reason).toBe('default-fallback');
    expect(d.routed).toBe(true);
  });

  it('显式 agentId 缺失（找不到）时逐级兜底，reason 标注 explicit-missing', () => {
    const d = resolveAgent({ agentId: 'ghost', category: 'ui' }, env);
    expect(d.agent.id).toBe('a2'); // 路由表兜底
    expect(d.reason).toBe('explicit-missing-route');

    const d2 = resolveAgent({ agentId: 'ghost', category: 'infra' }, env);
    expect(d2.agent.id).toBe('a3'); // 类别无表 → 默认兜底
    expect(d2.reason).toBe('explicit-missing-default');
  });

  it('类别大小写不敏感匹配路由表', () => {
    const envUpper = {
      agents: [ag('x1')],
      routeTable: { UI: { agentId: 'x1' } },
      defaultAgentId: null,
    };
    const d = resolveAgent({ category: 'ui' }, envUpper);
    expect(d.agent.id).toBe('x1');
    expect(d.reason).toBe('route-category');
  });

  it('无任何可用 agent 时抛错', () => {
    expect(() => resolveAgent({}, { agents: [], routeTable: {}, defaultAgentId: null })).toThrow(
      /没有可用的智能体/,
    );
  });

  it('项目默认缺失时取首个可用 agent', () => {
    const d = resolveAgent({}, { agents: [ag('z1'), ag('z2')], routeTable: {}, defaultAgentId: null });
    expect(d.agent.id).toBe('z1');
    expect(d.reason).toBe('first-available');
  });
});

describe('candidateChain 候选链', () => {
  const env = {
    agents: [ag('a1'), ag('a2'), ag('a3')],
    routeTable: { ui: { agentId: 'a1', fallback: ['a2', 'ghost'] } },
    defaultAgentId: 'a3',
  };

  it('首选 + fallback 链 + 默认 + 全部 agent，去重且过滤不存在', () => {
    const chain = candidateChain(env.agents[0]!, env, 'ui');
    expect(chain).toEqual(['a1', 'a2', 'a3']); // ghost 被过滤，a3 只出现一次
  });

  it('不同类别不串 fallback 链', () => {
    const chain = candidateChain(env.agents[0]!, env, 'logic');
    expect(chain).toEqual(['a1', 'a3', 'a2']); // a3 默认在前，然后全部 agent
  });
});

describe('resolveAgentForRunContext 特征并入', () => {
  it('RunContext.goal 长度并入复杂度特征，heavy 分档', () => {
    const env = { agents: [ag('a1')], routeTable: {}, defaultAgentId: null };
    const ctx = { goal: 'x'.repeat(9000) };
    const d = resolveAgentForRunContext({}, env, ctx);
    expect(d.tier).toBe('heavy');
    // 无显式绑定、无路由、无默认 → 取首个可用
    expect(d.agent.id).toBe('a1');
  });
});
