/**
 * G3：Agent 经济参数模型测试。
 *
 * 覆盖：resolveModelPrice 四级优先级（用户配置 > 订阅置 0 > 内置表 > 历史估计 > 默认）、
 * estimateCallCost 计费（缓存折扣/输出价/无 usage）、economicsOf 提取、aggregateCostByAgent 汇总。
 */
import { describe, it, expect } from 'vitest';
import { estimateCallCost, aggregateCostByAgent } from './agentEconomics';
import { economicsOf, resolveModelPrice, type AgentEconomics } from './routerScoring';
import type { AgentConfig } from '../types';

function ag(model: string, cost?: AgentEconomics, subscription?: boolean): AgentConfig {
  return {
    id: 'a1',
    name: 'a1',
    protocol: 'openai',
    baseUrl: 'http://x',
    model,
    cost,
    subscription,
  } as unknown as AgentConfig;
}

describe('resolveModelPrice 四级优先级', () => {
  it('订阅模型按 0 计价', () => {
    const p = resolveModelPrice(ag('gpt-5', undefined, true));
    expect(p).toEqual({ in: 0, out: 0 });
  });

  it('用户 cost 覆盖优先于内置表', () => {
    const p = resolveModelPrice(ag('gpt-4o', { inputPrice: 1, outputPrice: 2 }));
    expect(p).toEqual({ in: 1, out: 2 });
  });

  it('内置表命中优先于历史估计', () => {
    // gpt-4o-mini 在表内 $0.15/$0.6
    const p = resolveModelPrice(ag('gpt-4o-mini'), { in: 9, out: 9 });
    expect(p).toEqual({ in: 0.15, out: 0.6 });
  });

  it('内置表未知时用历史估计兜底', () => {
    const p = resolveModelPrice(ag('mystery-9000'), { in: 3, out: 7 });
    expect(p).toEqual({ in: 3, out: 7 });
  });

  it('全未知时用默认价', () => {
    const p = resolveModelPrice(ag('mystery-9000'));
    expect(p).toEqual({ in: 1, out: 3 });
  });

  it('部分覆盖：只给 inputPrice 时 output 走表内', () => {
    const p = resolveModelPrice(ag('gpt-4o', { inputPrice: 0.5 }));
    expect(p.in).toBe(0.5);
    expect(p.out).toBe(10); // gpt-4o 表内 out
  });
});

describe('estimateCallCost 计费', () => {
  it('无 usage 返回 null（无固定成本时）', () => {
    expect(estimateCallCost({ in: 1, out: 3 }, null)).toBeNull();
    expect(estimateCallCost({ in: 1, out: 3 }, undefined)).toBeNull();
  });

  it('空 usage 且无固定成本返回 0', () => {
    expect(estimateCallCost({ in: 1, out: 3 }, {})).toBe(0);
  });

  it('输入/输出按单价计费（每 1M token）', () => {
    // in=$2/1M, out=$8/1M；100K in + 50K out = $0.2 + $0.4 = $0.6
    const cost = estimateCallCost({ in: 2, out: 8 }, { promptTokens: 100_000, completionTokens: 50_000 });
    expect(cost).toBeCloseTo(0.6, 5);
  });

  it('缓存命中按输入价 10% 计，缓存写入全额', () => {
    // in=$1/1M；fresh=50K, cached=40K(×0.1), written=10K → 0.05+0.004+0.01=0.064
    const cost = estimateCallCost(
      { in: 1, out: 0 },
      { promptTokens: 100_000, cachedPromptTokens: 40_000, writtenPromptTokens: 10_000 },
    );
    expect(cost).toBeCloseTo(0.064, 5);
  });

  it('固定成本叠加', () => {
    const cost = estimateCallCost({ in: 1, out: 3 }, { promptTokens: 1_000_000 }, 0.5);
    expect(cost).toBeCloseTo(1.5, 5);
  });
});

describe('economicsOf / aggregateCostByAgent', () => {
  it('economicsOf 提取 cost 与 subscription', () => {
    const eco = economicsOf(ag('x', { inputPrice: 1 }, true));
    expect(eco.subscription).toBe(true);
    expect(eco.inputPrice).toBe(1);
  });

  it('aggregateCostByAgent 汇总调用数/成功率/token/成本', () => {
    const agg = aggregateCostByAgent([
      { agentId: 'a', model: 'gpt-4o-mini', usage: { promptTokens: 1_000_000, completionTokens: 0 }, ok: true, at: 't1' },
      { agentId: 'a', model: 'gpt-4o-mini', usage: { promptTokens: 1_000_000, completionTokens: 0 }, ok: false, at: 't2' },
    ]);
    const a = agg['a']!;
    expect(a.calls).toBe(2);
    expect(a.okCalls).toBe(1);
    expect(a.failCalls).toBe(1);
    expect(a.promptTokens).toBe(2_000_000);
    // gpt-4o-mini in=$0.15/1M × 2 = $0.3
    expect(a.costUsd).toBeCloseTo(0.3, 5);
    expect(a.lastAt).toBe('t2');
  });

  it('aggregateCostByAgent 订阅模型成本为 0', () => {
    const agg = aggregateCostByAgent([
      { agentId: 's', model: 'x', usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 }, ok: true, at: 't', cost: { subscription: true } },
    ]);
    expect(agg['s']!.costUsd).toBe(0);
  });
});
