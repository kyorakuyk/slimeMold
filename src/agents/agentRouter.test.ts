/**
 * AgentRouter 决策层单元测试（阶段 B）。
 *
 * 覆盖：显式绑定优先、显式缺失逐级兜底（类别路由→fallback 链→项目默认→首个）、
 * 无 agent 抛错、候选链生成、复杂度分档、RunContext 特征并入。
 */
import { describe, it, expect } from 'vitest';
import { estimateTier, resolveAgent, candidateChain, resolveAgentForRunContext, resolveAgentScored } from './agentRouter';
import type { AgentConfig, AgentRouteTable } from '../types';

const ag = (id: string, model = 'm1'): AgentConfig =>
  ({ id, name: id, protocol: 'openai', baseUrl: 'http://x', model, credentialKey: `k:${id}` } as AgentConfig);

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

  it('有 category 路由时：首选 + 类别 fallback 链（硬约束，不逃出类别）', () => {
    const chain = candidateChain(env.agents[0]!, env, 'ui');
    expect(chain).toEqual(['a1', 'a2']); // ghost 被过滤；ui 有专属路由，不再追加默认/全部
  });

  it('无 category 路由时：首选 + 默认 + 全部 agent，去重且过滤不存在', () => {
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

describe('resolveAgentScored 成本感知决策', () => {
  it('显式绑定有效时不评分，直接用', () => {
    const env = {
      agents: [ag('expensive', 'claude-opus-4'), ag('cheap', 'qwen2.5:3b')],
      routeTable: {},
      defaultAgentId: null,
    };
    const d = resolveAgentScored({ agentId: 'expensive', typeId: 'ai.chat' }, env);
    expect(d.agent.id).toBe('expensive');
    expect(d.reason).toBe('explicit');
    expect(d.scores).toBeUndefined();
  });

  it('light 任务：评分取便宜模型，chain 按评分降序', () => {
    const env = {
      agents: [ag('strong', 'claude-opus-4'), ag('local', 'qwen2.5:3b')],
      routeTable: {},
      defaultAgentId: null,
    };
    const d = resolveAgentScored({ typeId: 'ai.chat', textLength: 10 }, env);
    expect(d.reason).toBe('scored-optimal');
    expect(d.agent.id).toBe('local'); // light 任务便宜优先
    expect(d.chain[0]).toBe('local');
    expect(d.chain).toContain('strong');
    expect(d.scores).toBeTruthy();
    expect(d.scores![0]!.agent.id).toBe('local');
  });

  it('heavy 任务：light 档被否决（评分选标准/强档）', () => {
    const env = {
      agents: [ag('strong', 'claude-opus-4'), ag('local', 'qwen2.5:3b'), ag('mid', 'gpt-4o')],
      routeTable: {},
      defaultAgentId: null,
    };
    const d = resolveAgentScored({ typeId: 'ai.chat', textLength: 99999 }, env);
    // local（light 档）被 heavy 否决；gpt-4o 凭性价比胜出
    expect(d.agent.id).toBe('mid');
    expect(d.chain[d.chain.length - 1]).toBe('local'); // 被否决的排最后
  });

  it('成功率影响排序：成功率高的候选胜出', () => {
    const env = {
      agents: [ag('a', 'gpt-4o-mini'), ag('b', 'gpt-4o')],
      routeTable: {},
      defaultAgentId: null,
    };
    // 无成功率时 light 任务 a（便宜）胜
    expect(resolveAgentScored({ typeId: 'x', textLength: 10 }, env).agent.id).toBe('a');
    // b 成功率 0.9 vs a 0.1：b 可能仍不敌 a 的成本优势；用极端权重验证成功率起作用
    const d = resolveAgentScored(
      { typeId: 'x', textLength: 10 },
      env,
      { successByAgent: { a: 0.05, b: 1 }, weights: { cost: 0.1, success: 0.8, tierFit: 0.1 } },
    );
    expect(d.agent.id).toBe('b');
  });

  it('无任何可用 agent 抛错', () => {
    expect(() =>
      resolveAgentScored({}, { agents: [], routeTable: {}, defaultAgentId: null }),
    ).toThrow(/没有可用的智能体/);
  });
});
