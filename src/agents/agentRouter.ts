/**
 * agentRouter.ts — AgentRouter 运行时决策层（Codex 规划阶段 B）。
 *
 * 背景：此前「用哪个 agent / 模型」割裂在两处——① 节点参数写死 agentId（dispatch.plan /
 * architect.design 的 agentId 参数），② Builder 生成 worker 时按 agentRouteTable 静态绑定。
 * 二者都只在「配置期」决定，运行期没有任何决策/兜底：节点没绑 agent、或绑的 agent 不存在
 * （被删/改名）时直接抛错，项目级路由表在运行时完全失效。
 *
 * 本模块提供**运行时统一决策**：
 * - resolveAgent：按「显式绑定 > 类别路由表 > 路由项 fallback 链 > 项目默认 > 首个可用」逐级
 *   兜底，永不因「没绑 / 绑错」而白白失败；决策原因（reason）与回退链（chain）可观测。
 * - candidateChain：由一次决策生成完整候选链（含 fallback），供「失败后换 agent 重试」使用。
 * - estimateTier：按输入特征（scope 大小 / 文本长度）给出复杂度分档（light/standard/heavy），
 *   仅供日志与事件标注，不做模型强制切换（避免臆造升降级规则）。
 *
 * 设计原则：纯函数、零 store / React 依赖，可在 jsdom 下直接单测；不改变「显式绑定有效」的
 * 既有行为——显式 agentId 存在时就是它，本层只在缺失/失效时兜底与记录。
 */
import type { AgentConfig, AgentRouteTable } from '../types';
import type { RunContext } from '../engine/runContext';
import { scoreCandidates, type CandidateScore, type ScoringWeights } from './routerScoring';

/**
 * 判断 Agent 是否「可调用」：避免评分选出明显必败的 Agent（无 baseUrl / 无模型 / 无凭据）。
 * - ollama：本地模型只需 baseUrl，不需要 key。
 * - 非 ollama：baseUrl + model + 凭据（credentialKey 或 apiKey）三者缺一不可，
 *   否则一次请求必然 401/失败，白白浪费时间与成本。
 */
export function isAgentCallable(a: AgentConfig): boolean {
  if (!a.baseUrl?.trim()) return false;
  if (!a.model?.trim()) return false;
  if (a.protocol === 'ollama') return true;
  return !!(a.credentialKey?.trim() || a.apiKey?.trim());
}

/** 路由请求：一次 LLM 调用的路由上下文。 */
export interface RouterRequest {
  /** 显式指定的 agent id（节点参数 / Builder 绑定），优先于一切路由规则 */
  agentId?: string;
  /** 节点级模型覆盖（modelOverride） */
  modelOverride?: string;
  /** 任务类别（ui/logic/docs/infra/data…），查项目级路由表用 */
  category?: string;
  /** 影响域大小（scope 文件/模块数）——复杂度特征 */
  scopeSize?: number;
  /** 目标 / 输入文本长度——复杂度特征 */
  textLength?: number;
  /** 节点类型（typeId），便于诊断与日志 */
  typeId?: string;
}

/** 路由环境：运行时可用的全部决策输入。 */
export interface RouterEnv {
  /** 项目已配置的全部智能体（AgentConfig[]） */
  agents: AgentConfig[];
  /** 项目级「类别 → agent」路由表 */
  routeTable: AgentRouteTable;
  /** 项目默认 agent id（defaultAgentId），兜底链之一 */
  defaultAgentId: string | null;
}

/** 一次路由决策的完整结果。 */
export interface RouterDecision {
  /** 最终选定的智能体 */
  agent: AgentConfig;
  /** 生效模型（agent.model；modelOverride 由调用方自行套用） */
  model: string;
  /** 决策原因（供日志 / 事件展示，如 'explicit' / 'route-category' / 'default-fallback'） */
  reason: string;
  /** 完整候选链（含首选与各级 fallback），供失败重试按序尝试 */
  chain: string[];
  /** 是否经历了路由（true = 非直接用显式绑定，而是查表/兜底得出） */
  routed: boolean;
  /** 复杂度分档（estimateTier 结果，供事件标注） */
  tier: 'light' | 'standard' | 'heavy';
  /** 成本感知评分明细（走 resolveAgentScored 时填充；固定顺序路径为空） */
  scores?: CandidateScore[];
}

/** 成本感知评分选项（供 resolveAgentScored）。 */
export interface ScoringOptions {
  /** 各 agent 历史成功率（projectId 维度，经验库统计） */
  successByAgent?: Record<string, number>;
  /** 评分权重覆盖 */
  weights?: Partial<ScoringWeights>;
}

/** 复杂度特征输入（供 estimateTier）。 */
export interface TierFeatures {
  scopeSize?: number;
  textLength?: number;
}

/**
 * 按输入特征给出复杂度分档（描述性，不强制改模型）：
 * - 目标/文本 ≥ 8000 字，或影响域 ≥ 12 → heavy
 * - 目标/文本 ≥ 2000 字，或影响域 ≥ 4 → standard
 * - 其余 → light
 */
export function estimateTier(f: TierFeatures): 'light' | 'standard' | 'heavy' {
  const len = f.textLength ?? 0;
  const scope = f.scopeSize ?? 0;
  if (len >= 8000 || scope >= 12) return 'heavy';
  if (len >= 2000 || scope >= 4) return 'standard';
  return 'light';
}

/** 兜底路由的保留键：当 category 为空/无法推断，或未配置任何类别路由项时生效。
 *  该键不在 CATEGORY_KEYS 中，避免被当作真实 category 参与大小写匹配。 */
export const FALLBACK_CATEGORY = '__fallback__';

/**
 * 按类别取路由表项（大小写不敏感键匹配）。
 * category 为空或未匹配任何类别时，回退到兜底条目（FALLBACK_CATEGORY，需已配置内容才生效）。
 */
function routeEntry(routeTable: AgentRouteTable, category?: string): { agentId?: string; fallback?: string[] } | undefined {
  const key = (category ?? '').toLowerCase().trim();
  // 1) 有 category：优先精确匹配，其次大小写不敏感匹配（跳过兜底保留键）
  if (key) {
    if (routeTable[key]) return routeTable[key];
    const matched = Object.keys(routeTable).find((k) => k !== FALLBACK_CATEGORY && k.toLowerCase() === key);
    if (matched) return routeTable[matched];
  }
  // 2) category 为空或未匹配 → 若配置了兜底条目则用它兜底
  const fallback = routeTable[FALLBACK_CATEGORY];
  if (fallback && (fallback.agentId || (fallback.fallback?.length ?? 0) > 0)) return fallback;
  return undefined;
}

/**
 * 由选定 agent + 决策上下文生成完整候选链：
 * 首选 + 类别路由项 fallback + 项目默认 + 全部已配置 agent，去重并过滤不存在的 id。
 */
export function candidateChain(
  agent: AgentConfig,
  env: RouterEnv,
  category?: string,
): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  const push = (id?: string | null) => {
    if (!id || seen.has(id)) return;
    if (!env.agents.some((a) => a.id === id)) return; // 过滤已不存在的 agent
    seen.add(id);
    chain.push(id);
  };
  push(agent.id);
  const entry = routeEntry(env.routeTable, category);
  const hasCategoryRoute = !!(entry?.agentId || (entry?.fallback?.length ?? 0) > 0);
  if (hasCategoryRoute) {
    // category 是硬路由约束：fallback 链局限在类别内，不逃出到 default/全部
    for (const f of entry?.fallback ?? []) push(f);
  } else {
    for (const f of entry?.fallback ?? []) push(f);
    push(env.defaultAgentId);
    for (const a of env.agents) push(a.id);
  }
  return chain;
}

/** 构造决策对象（统一收口 reason/chain/tier 三件套）。 */
function makeDecision(
  agent: AgentConfig,
  reason: string,
  routed: boolean,
  env: RouterEnv,
  category: string | undefined,
  tier: 'light' | 'standard' | 'heavy',
): RouterDecision {
  return {
    agent,
    model: agent.model,
    reason,
    chain: candidateChain(agent, env, category),
    routed,
    tier,
  };
}

/**
 * 运行时决策：解析一次 LLM 调用实际应使用的智能体。
 * 优先级：显式 agentId（存在）→ 显式缺失时兜底 → 类别路由表 → 路由项 fallback → 项目默认
 * → 首个可用 agent；全空则抛错（此时确实无可调用模型）。
 */
export function resolveAgent(request: RouterRequest, env: RouterEnv): RouterDecision {
  const tier = estimateTier(request);
  // 兼容「按 id 或 名称」引用：先按 id 精确匹配，找不到再按 name（忽略大小写与首尾空格）。
  // 解决 council/worker 等节点用「名字」填 agentId 时匹配不上（真实 id 是 UUID）的问题。
  const byId = (id?: string | null) => {
    if (!id) return undefined;
    const byExact = env.agents.find((a) => a.id === id);
    if (byExact) return byExact;
    const n = id.trim().toLowerCase();
    return env.agents.find((a) => a.name?.trim().toLowerCase() === n);
  };

  // ① 显式绑定：存在即用（保持既有行为）
  const explicit = byId(request.agentId);
  if (explicit) {
    return makeDecision(explicit, 'explicit', false, env, request.category, tier);
  }

  const entry = routeEntry(env.routeTable, request.category);

  // ② 类别路由表主 agent
  if (entry?.agentId) {
    const routedAgent = byId(entry.agentId);
    if (routedAgent) {
      return makeDecision(
        routedAgent,
        request.agentId ? 'explicit-missing-route' : 'route-category',
        true,
        env,
        request.category,
        tier,
      );
    }
  }

  // ③ 类别路由表 fallback 链：按序取第一个可用
  for (const fid of entry?.fallback ?? []) {
    const fAgent = byId(fid);
    if (fAgent) {
      return makeDecision(fAgent, 'route-fallback', true, env, request.category, tier);
    }
  }

  // ④ 项目默认 agent
  const defAgent = byId(env.defaultAgentId);
  if (defAgent) {
    return makeDecision(
      defAgent,
      request.agentId ? 'explicit-missing-default' : 'default-fallback',
      true,
      env,
      request.category,
      tier,
    );
  }

  // ⑤ 首个可用 agent
  const first = env.agents[0];
  if (first) {
    return makeDecision(
      first,
      request.agentId ? 'explicit-missing-first' : 'first-available',
      true,
      env,
      request.category,
      tier,
    );
  }

  throw new Error('没有可用的智能体：请先在设置中配置智能体（Agent）再运行');
}

/**
 * 运行时决策（带 RunContext 版本）：把目标文本并入复杂度特征，
 * 供 executor 在 `ctx.llm` 兜底时调用（RunContext 为 A1 定型的运行载体）。
 */
export function resolveAgentForRunContext(
  request: RouterRequest,
  env: RouterEnv,
  ctx: Pick<RunContext, 'goal'> | null,
): RouterDecision {
  const merged: RouterRequest = {
    ...request,
    textLength: request.textLength ?? (ctx?.goal ? ctx.goal.length : 0),
  };
  return resolveAgent(merged, env);
}

/**
 * 成本感知运行时决策（二轮评审「AgentRouter 还不是成本感知」）：
 * - 显式 agentId 有效 → 直接用（尊重用户绑定，不评分）
 * - 否则对候选集（路由主 → fallback 链 → 默认 → 全部）做成本感知评分，
 *   取分数最高的 agent；chain 按评分降序（失败重试即从次优开始）。
 * - decision.scores 携带完整评分明细，供事件/日志/UI 展示决策依据。
 * 候选集为空抛错（同 resolveAgent）。
 */
export function resolveAgentScored(
  request: RouterRequest,
  env: RouterEnv,
  scoring: ScoringOptions = {},
): RouterDecision {
  const tier = estimateTier(request);
  // 兼容「按 id 或 名称」引用（同 resolveAgent）
  const byId = (id?: string | null) => {
    if (!id) return undefined;
    const byExact = env.agents.find((a) => a.id === id);
    if (byExact) return byExact;
    const n = id.trim().toLowerCase();
    return env.agents.find((a) => a.name?.trim().toLowerCase() === n);
  };

  // 显式绑定有效：不评分，保持原有行为
  const explicit = byId(request.agentId);
  if (explicit) {
    return makeDecision(explicit, 'explicit', false, env, request.category, tier);
  }

  // 构建候选集（去重且过滤不存在的 agent）。
  // category 是「硬路由约束」：若类别路由表配置了主 agent / fallback，
  // 评分只在类别候选内进行，绝不跨类别选到不属于该类的 agent；
  // 仅当类别链路完全为空（未配置该类别）时才回退到「默认 + 全部」全局评分。
  const entry = routeEntry(env.routeTable, request.category);
  const pool: AgentConfig[] = [];
  const seen = new Set<string>();
  const add = (id?: string | null) => {
    if (!id || seen.has(id)) return;
    const a = byId(id);
    // P2：评分前过滤不可调用的 Agent（无 baseUrl/model/凭据），避免选中后必败请求
    if (a && isAgentCallable(a)) {
      seen.add(id);
      pool.push(a);
    }
  };
  const hasCategoryRoute = !!(entry?.agentId || (entry?.fallback?.length ?? 0) > 0);
  if (hasCategoryRoute) {
    add(entry?.agentId);
    for (const f of entry?.fallback ?? []) add(f);
  } else {
    add(env.defaultAgentId);
    for (const a of env.agents) add(a.id);
  }
  if (pool.length === 0) {
    throw new Error('没有可用的智能体：请先在设置中配置智能体（Agent）再运行');
  }

  // 成本感知评分排序，取最优
  const scored = scoreCandidates({
    candidates: pool,
    tier,
    successByAgent: scoring.successByAgent,
    weights: scoring.weights,
  });
  const best = scored[0]!;
  return {
    agent: best.agent,
    model: best.agent.model,
    reason: request.agentId ? 'explicit-missing-scored' : 'scored-optimal',
    chain: scored.map((c) => c.agent.id),
    routed: true,
    tier,
    scores: scored,
  };
}
