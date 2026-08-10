/**
 * agentEconomics.ts — Agent 经济模型：成本估算与汇总（Codex 设计评审 G3，P1）。
 *
 * 价格解析（四级优先级：用户配置 > 内置表 > 历史估计 > 默认）在 routerScoring 的
 * `resolveModelPrice`/`AgentEconomics`/`HistoricalPrice`（本模块依赖它，避免循环依赖）。
 * 本模块专注「用价格算钱」：
 * - `estimateCallCost(price, usage, fixedCost)`：按 TokenUsage 估算一次调用美元成本
 *   （输入/输出分开计价；缓存命中按输入价 10% 计；缓存写入全额；可叠固定成本）。
 * - `aggregateCostByAgent(records)`：把一组 CostRecord 汇总为按 agent 的累计成本/用量。
 *
 * 设计原则：纯函数、零 store 依赖。
 */
import { modelPrice, type ModelPrice } from './routerScoring';

export type { AgentEconomics, HistoricalPrice } from './routerScoring';
export { economicsOf, resolveModelPrice } from './routerScoring';

/**
 * 估算一次调用的美元成本（基于 TokenUsage）。
 * - 输入 token 按输入价计；缓存命中（cachedPromptTokens）按输入价的 10% 计；
 *   缓存写入（writtenPromptTokens）按输入价全额计。
 * - 输出 token 按输出价计。
 * - 无 usage 时返回 null（无法估算）；空 usage 且无固定成本返回 0。
 */
export function estimateCallCost(
  price: ModelPrice,
  usage: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number; writtenPromptTokens?: number } | null | undefined,
  fixedCost = 0,
): number | null {
  if (!usage) return fixedCost > 0 ? fixedCost : null;
  const prompt = usage.promptTokens ?? 0;
  const cached = usage.cachedPromptTokens ?? 0;
  const written = usage.writtenPromptTokens ?? 0;
  // promptTokens 可能已含 cached/written，避免重复计费：新增输入 = prompt - cached - written
  const freshPrompt = Math.max(0, prompt - cached - written);
  const completion = usage.completionTokens ?? 0;
  if (freshPrompt === 0 && completion === 0 && cached === 0 && written === 0 && fixedCost === 0) return 0;
  const cost =
    (freshPrompt * price.in) / 1_000_000 +
    (cached * price.in * 0.1) / 1_000_000 +
    (written * price.in) / 1_000_000 +
    (completion * price.out) / 1_000_000 +
    fixedCost;
  return Number(cost.toFixed(6));
}

/** 单条成本记录输入（aggregateCostByAgent 的入参形状，兼容 executor 的 CostRecord 子集）。 */
export interface CostRecordInput {
  agentId: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number; writtenPromptTokens?: number };
  ok: boolean;
  at: string;
  cost?: { inputPrice?: number; outputPrice?: number; fixedCost?: number; subscription?: boolean };
}

/** 按 agent 聚合的累计成本/用量。 */
export interface AgentCostAggregate {
  agentId: string;
  model: string;
  calls: number;
  okCalls: number;
  failCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  lastAt: string;
}

/**
 * 汇总一组成本记录为按 agent 的累计成本与用量（供统计/展示）。
 */
export function aggregateCostByAgent(records: CostRecordInput[]): Record<string, AgentCostAggregate> {
  const out: Record<string, AgentCostAggregate> = {};
  for (const r of records) {
    const a = (out[r.agentId] ??= {
      agentId: r.agentId,
      model: r.model,
      calls: 0,
      okCalls: 0,
      failCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      lastAt: r.at,
    });
    a.calls += 1;
    if (r.ok) a.okCalls += 1;
    else a.failCalls += 1;
    a.promptTokens += r.usage?.promptTokens ?? 0;
    a.completionTokens += r.usage?.completionTokens ?? 0;
    const price = r.cost?.subscription
      ? { in: 0, out: 0 }
      : {
          in: r.cost?.inputPrice ?? modelPrice(r.model).in,
          out: r.cost?.outputPrice ?? modelPrice(r.model).out,
        };
    const est = estimateCallCost(price, r.usage, r.cost?.fixedCost ?? 0);
    if (est != null) a.costUsd += est;
    if (r.at > a.lastAt) a.lastAt = r.at;
  }
  return out;
}
