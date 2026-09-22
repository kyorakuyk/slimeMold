/**
 * 成本感知路由评分器测试（二轮评审「AgentRouter 还不是成本感知」）。
 *
 * 覆盖：价格表查询（精确/子串/未知）、模型档位、档位匹配分、评分排序
 * （便宜优先、light 任务选轻档、heavy 任务选强档、成功率影响、权重覆盖）。
 */
import { describe, it, expect } from 'vitest';
import {
  modelPrice,
  modelTier,
  tierFitScore,
  scoreCandidates,
  DEFAULT_SCORING_WEIGHTS,
} from './routerScoring';
import type { AgentConfig } from '../types/agent';

const ag = (id: string, model: string): AgentConfig =>
  ({ id, name: id, protocol: 'openai', baseUrl: 'http://x', model } as AgentConfig);

describe('modelPrice 价格表（2026-07 快照）', () => {
  it('精确匹配已知模型', () => {
    expect(modelPrice('gpt-4o-mini').in).toBe(0.15);
    expect(modelPrice('deepseek-chat').out).toBe(0.28);
    // 最新快照：Haiku 4.5 $1/$5、Opus 4.8 $5/$25、Sonnet 5 $2/$10
    expect(modelPrice('claude-haiku-4-5')).toEqual({ in: 1, out: 5 });
    expect(modelPrice('claude-opus-4-8')).toEqual({ in: 5, out: 25 });
    expect(modelPrice('claude-sonnet-5')).toEqual({ in: 2, out: 10 });
  });

  it('新模型已收录（Gemini/Grok/GPT-5 系）', () => {
    expect(modelPrice('gemini-2.5-flash')).toEqual({ in: 0.15, out: 0.6 });
    expect(modelPrice('gemini-3.1-pro')).toEqual({ in: 2, out: 12 });
    expect(modelPrice('grok-4.1')).toEqual({ in: 0.2, out: 0.5 });
    expect(modelPrice('gpt-5.5')).toEqual({ in: 5, out: 30 });
  });

  it('GPT-5.6 三档已收录（Sol/Terra/Luna，含最新调价）', () => {
    expect(modelPrice('gpt-5.6-sol')).toEqual({ in: 5, out: 30 });
    expect(modelPrice('gpt-5.6-terra')).toEqual({ in: 2, out: 12 }); // 降 20%
    expect(modelPrice('gpt-5.6-luna')).toEqual({ in: 0.2, out: 1.2 }); // 降 80%
  });

  it('子串匹配（带供应商前缀/后缀）', () => {
    expect(modelPrice('openai/gpt-4o-mini').in).toBe(0.15);
    expect(modelPrice('deepseek-ai/DeepSeek-V3').in).toBe(0.27);
  });

  it('本地 Ollama 模型 0 计价', () => {
    expect(modelPrice('qwen2.5:3b')).toEqual({ in: 0, out: 0 });
    expect(modelPrice('qwen3:8b')).toEqual({ in: 0, out: 0 });
  });

  it('未知模型走默认价', () => {
    expect(modelPrice('mystery-model')).toEqual({ in: 1, out: 3 });
  });
});

describe('modelTier 模型档位', () => {
  it('heavy：强推理模型', () => {
    expect(modelTier('claude-opus-4')).toBe('heavy');
    expect(modelTier('deepseek-r1')).toBe('heavy');
    expect(modelTier('gpt-4.1')).toBe('heavy');
    expect(modelTier('o3')).toBe('heavy');
    expect(modelTier('gpt-5.5')).toBe('heavy');
    expect(modelTier('gemini-3.1-pro')).toBe('heavy');
    expect(modelTier('claude-fable-5')).toBe('heavy');
    expect(modelTier('grok-4')).toBe('heavy'); // 旗舰（$3/$15）
    expect(modelTier('gpt-5.6-sol')).toBe('heavy'); // 旗舰
    expect(modelTier('gpt-5.6-terra')).toBe('heavy'); // 中端推理
  });

  it('light：轻量/本地模型（含带后缀轻量变体）', () => {
    expect(modelTier('gpt-4o-mini')).toBe('light');
    expect(modelTier('gpt-4.1-mini')).toBe('light');
    expect(modelTier('o4-mini')).toBe('light');
    expect(modelTier('grok-4.1')).toBe('light');
    expect(modelTier('gemini-2.5-flash')).toBe('light');
    expect(modelTier('qwen2.5:3b')).toBe('light');
    expect(modelTier('llama3.1:8b')).toBe('light');
    expect(modelTier('gpt-5.6-luna')).toBe('light'); // 快速轻量档
  });

  it('standard：默认档', () => {
    expect(modelTier('gpt-4o')).toBe('standard');
    expect(modelTier('deepseek-chat')).toBe('standard');
  });
});

describe('tierFitScore 档位匹配', () => {
  it('同档 1.0 / 差一档 0.6 / 差两档 0.3', () => {
    expect(tierFitScore('light', 'light')).toBe(1);
    expect(tierFitScore('light', 'standard')).toBe(0.6);
    expect(tierFitScore('light', 'heavy')).toBe(0.3);
    expect(tierFitScore('heavy', 'heavy')).toBe(1);
    expect(tierFitScore('heavy', 'light')).toBe(0.3);
  });
});

describe('scoreCandidates 评分排序', () => {
  it('light 任务：便宜模型优先（本地零成本 > 高端）', () => {
    const c = scoreCandidates({
      candidates: [ag('local', 'qwen2.5:3b'), ag('strong', 'claude-opus-4'), ag('mid', 'gpt-4o')],
      tier: 'light',
    });
    // 零成本本地模型评分最高（即使档位 light 匹配满分）
    expect(c[0]!.agent.id).toBe('local');
    expect(c[0]!.costPer1M).toBe(0);
  });

  it('heavy 任务：light 档被否决，标准档凭性价比胜出强档', () => {
    const c = scoreCandidates({
      candidates: [ag('local', 'qwen2.5:3b'), ag('strong', 'claude-opus-4'), ag('mid', 'gpt-4o')],
      tier: 'heavy',
    });
    // local（light 档）被否决排最后；gpt-4o（标准档、便宜 7 倍）综合评分胜出 claude-opus——
    // 成本感知语义：heavy 任务禁选 light 档，但同档/近档内价格敏感。
    expect(c[0]!.agent.id).toBe('mid');
    expect(c[1]!.agent.id).toBe('strong');
    expect(c[2]!.agent.id).toBe('local');
    expect(c[2]!.score).toBe(Number.NEGATIVE_INFINITY);
  });

  it('成功率垫底的候选被降权', () => {
    const c = scoreCandidates({
      candidates: [ag('a', 'gpt-4o-mini'), ag('b', 'gpt-4o')],
      tier: 'light',
      successByAgent: { b: 0.9, a: 0.1 },
    });
    // a 便宜且档位 light，但成功率仅 0.1 → 综合可能仍高；验证 b 成功率加成后排序
    // 成本权重 0.35：a 成本分 1.0，b 成本分 0（贵）；成功率 0.35：a 0.1 vs b 0.9；
    // 档位 0.3：a 1.0 vs b 0.6
    // a = 0.35*1 + 0.35*0.1 + 0.3*1 = 0.685
    // b = 0.35*0 + 0.35*0.9 + 0.3*0.6 = 0.495
    expect(c[0]!.agent.id).toBe('a');
    // 无成功率数据时默认 0.5
    const c2 = scoreCandidates({ candidates: [ag('a', 'gpt-4o-mini')], tier: 'light' });
    expect(c2[0]!.successRate).toBe(0.5);
  });

  it('heavy 任务硬性否决 light 档（即使免费）', () => {
    const c = scoreCandidates({
      candidates: [ag('local', 'qwen2.5:3b'), ag('mid', 'gpt-4o')],
      tier: 'heavy',
    });
    // light 档被否决（score = -Infinity），gpt-4o 胜出
    expect(c[0]!.agent.id).toBe('mid');
    expect(c[1]!.agent.id).toBe('local');
    expect(c[1]!.score).toBe(Number.NEGATIVE_INFINITY);
  });

  it('权重覆盖：standard 任务强权重成本时便宜模型胜出', () => {
    const c = scoreCandidates({
      candidates: [ag('local', 'qwen2.5:3b'), ag('strong', 'claude-opus-4')],
      tier: 'standard',
      weights: { cost: 0.9, success: 0.05, tierFit: 0.05 },
    });
    // standard 任务不禁 light 档；成本权重极高：本地免费模型胜出
    expect(c[0]!.agent.id).toBe('local');
  });

  it('单候选直接返回；空候选返回空数组', () => {
    expect(scoreCandidates({ candidates: [ag('a', 'gpt-4o')], tier: 'standard' })).toHaveLength(1);
    expect(scoreCandidates({ candidates: [], tier: 'light' })).toHaveLength(0);
  });

  it('默认权重成本/成功/档位 = 0.35/0.35/0.30', () => {
    expect(DEFAULT_SCORING_WEIGHTS).toEqual({ cost: 0.35, success: 0.35, tierFit: 0.3 });
  });
});
