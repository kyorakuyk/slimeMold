/**
 * routerScoring.ts — 成本感知路由评分器（Codex 二轮评审「AgentRouter 还不是成本感知」）。
 *
 * 把 AgentRouter 的「固定顺序 fallback」升级为「按评分排序」：
 * - 成本分（costScore）：按模型价格表（每 1M token USD）候选集内归一化，越便宜越高；
 *   本地 Ollama 模型按 0 计价（无 API 费用）。
 * - 成功率分（successScore）：按 agentId 从经验库统计历史成功率，无数据默认 0.5。
 * - 档位匹配分（tierFitScore）：任务复杂度 tier 与模型能力档位匹配度——
 *   同档 1.0、差一档 0.6、差两档 0.3（heavy 任务不选轻量模型、light 任务不浪费强模型）。
 *
 * 策略效果：「便宜模型优先、复杂任务升级」——light 任务偏好零成本/低端模型，
 * heavy 任务宁可多花钱也选强档模型；成功率垫底的候选被降权。
 *
 * 设计原则：纯函数、零 store / React 依赖；无评分上下文时调用方可完全跳过本模块，
 * 保持原「固定顺序」行为（向后兼容）。
 */
import type { AgentConfig } from '../types';

/** 模型价格（USD / 1M tokens）。 */
export interface ModelPrice {
  in: number;
  out: number;
}

/** 内置价格表（粗粒度，按常见主流模型；未知模型走默认值）。key 小写、支持子串匹配。 */
export const MODEL_PRICE_PER_1M: Record<string, ModelPrice> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4': { in: 30, out: 60 },
  'deepseek-chat': { in: 0.14, out: 0.28 },
  'deepseek-v3': { in: 0.27, out: 1.1 },
  'deepseek-r1': { in: 0.55, out: 2.19 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-opus': { in: 15, out: 75 },
  'claude-haiku': { in: 0.8, out: 4 },
  'o1': { in: 15, out: 60 },
  'o3': { in: 2, out: 8 },
  'llama3.1:8b': { in: 0, out: 0 }, // 本地 Ollama，无 API 费用
  'qwen2.5': { in: 0, out: 0 }, // 本地 Ollama 系列
  'llama3': { in: 0, out: 0 },
  'mistral': { in: 0, out: 0 },
};

/** 未知模型的默认价（中等偏上，避免误判为超便宜/超贵）。 */
export const DEFAULT_MODEL_PRICE: ModelPrice = { in: 1, out: 3 };

/** 查模型价格：先精确匹配，再按小写子串匹配；未知返回默认。 */
export function modelPrice(model: string): ModelPrice {
  const m = (model ?? '').toLowerCase();
  if (!m) return DEFAULT_MODEL_PRICE;
  if (MODEL_PRICE_PER_1M[m]) return MODEL_PRICE_PER_1M[m];
  for (const [key, price] of Object.entries(MODEL_PRICE_PER_1M)) {
    if (m.includes(key)) return price;
  }
  return DEFAULT_MODEL_PRICE;
}

/** 模型能力档位（按名称关键字启发式；未知归 standard）。 */
export function modelTier(model: string): 'light' | 'standard' | 'heavy' {
  const m = (model ?? '').toLowerCase();
  if (
    /(opus|gpt-4\.1|o1|o3|deepseek-r1|deepseek-reasoner|claude-opus)/.test(m)
  ) return 'heavy';
  if (
    /(mini|flash|3b|7b|8b|llama3|qwen2\.5|mistral|haiku|0\.5b)/.test(m)
  ) return 'light';
  return 'standard';
}

/** 档位匹配度：同档 1.0 / 差一档 0.6 / 差两档 0.3。 */
export function tierFitScore(taskTier: 'light' | 'standard' | 'heavy', modelTierOfModel: 'light' | 'standard' | 'heavy'): number {
  if (taskTier === modelTierOfModel) return 1;
  const order = ['light', 'standard', 'heavy'];
  const diff = Math.abs(order.indexOf(taskTier) - order.indexOf(modelTierOfModel));
  return diff === 1 ? 0.6 : 0.3;
}

/** 评分权重（默认：成本 0.35 / 成功率 0.35 / 档位匹配 0.30）。 */
export interface ScoringWeights {
  cost: number;
  success: number;
  tierFit: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = { cost: 0.35, success: 0.35, tierFit: 0.3 };

/** 单个候选的评分明细（决策可观测）。 */
export interface CandidateScore {
  agent: AgentConfig;
  score: number;
  /** 每 1M token 总价（USD） */
  costPer1M: number;
  /** 成本分（0-1，候选集内归一化） */
  costScore: number;
  /** 成功率（0-1，缺省 0.5） */
  successRate: number;
  /** 档位匹配分（0-1） */
  tierFit: number;
  /** 模型能力档位 */
  modelTier: 'light' | 'standard' | 'heavy';
  /** 评分依据（诊断用） */
  reasons: string[];
}

/** 评分输入。 */
export interface ScoringInput {
  /** 候选 agent 集（评分排序对象） */
  candidates: AgentConfig[];
  /** 任务复杂度档位 */
  tier: 'light' | 'standard' | 'heavy';
  /** 各 agent 历史成功率（projectId 维度，经验库统计） */
  successByAgent?: Record<string, number>;
  /** 权重覆盖（缺省用 DEFAULT_SCORING_WEIGHTS） */
  weights?: Partial<ScoringWeights>;
}

/**
 * 档位硬性否决：任务 heavy 时禁选 light 档模型；任务 light 时不禁（可降级用强模型，浪费但可用）。
 * 避免「便宜模型霸榜重任务」——成本分线性归一化下免费 light 模型会压过档位权重。
 */
function isDisqualified(tier: 'light' | 'standard' | 'heavy', mTier: 'light' | 'standard' | 'heavy'): boolean {
  return tier === 'heavy' && mTier === 'light';
}

/**
 * 对候选集评分并按分数降序排序。
 * - heavy 任务：light 档模型被硬性否决（score 置 -Infinity，排最后）。
 * - 若候选 ≤1 直接返回；免费模型成本分最高；成功率缺省 0.5。
 */
export function scoreCandidates(input: ScoringInput): CandidateScore[] {
  const { candidates, tier, successByAgent, weights } = input;
  const w: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...weights };
  if (candidates.length === 0) return [];

  const priced = candidates.map((agent) => {
    const p = modelPrice(agent.model);
    return { agent, costPer1M: p.in + p.out };
  });
  const min = Math.min(...priced.map((x) => x.costPer1M));
  const max = Math.max(...priced.map((x) => x.costPer1M));
  const span = max - min;

  const scored: CandidateScore[] = priced.map(({ agent, costPer1M }) => {
    const costScore = span === 0 ? 0.5 : 1 - (costPer1M - min) / span;
    const successRate = successByAgent?.[agent.id] ?? 0.5;
    const mTier = modelTier(agent.model);
    const tFit = tierFitScore(tier, mTier);
    const disqual = isDisqualified(tier, mTier);
    const score = disqual ? Number.NEGATIVE_INFINITY : w.cost * costScore + w.success * successRate + w.tierFit * tFit;
    const reasons = [
      `成本 $${costPer1M.toFixed(2)}/1M → ${costScore.toFixed(2)}`,
      `成功率 ${(successRate * 100).toFixed(0)}% → ${successRate.toFixed(2)}`,
      `档位 ${mTier}(任务 ${tier}) → ${tFit.toFixed(2)}${disqual ? '（heavy 任务否决 light 档）' : ''}`,
    ];
    return { agent, score, costPer1M, costScore, successRate, tierFit: tFit, modelTier: mTier, reasons };
  });

  return scored.sort((a, b) => b.score - a.score);
}
