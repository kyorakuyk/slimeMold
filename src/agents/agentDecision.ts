/**
 * agentDecision.ts — AgentRouter 运行时决策辅助（executeNode.ctx.llm 拆分，Codex「审视并拆分 executeNode」）。
 *
 * 把 executeNode.ctx.llm 里的「AgentRouter 决策段」抽为纯函数 decideAgentCall：
 * - 合并项目级 ∪ 全局 agent 池（项目级同名覆盖全局），过滤禁用
 * - 目标工作流名（goal 特征）
 * - category 参数提取
 * - resolveAgentScored 评分决策（含成功率）
 *
 * 返回决策 + 路由日志文案（供调用方 emit/写日志），不依赖 executeNode 可变闭包。
 */
import type { AgentConfig } from '../types/agent';
import type { AgentRouteTable } from '../types/dispatch';
import { resolveAgentScored, type RouterDecision } from './agentRouter';
import { successRateByAgent } from './experienceStore';

/** decideAgentCall 输入。 */
export interface AgentDecisionInput {
  /** 请求的 agentId（可能缺失/失效） */
  requestedAgentId?: string | null;
  /** 节点 typeId（特征与诊断） */
  typeId: string;
  /** 节点 params（category/scope） */
  params?: Record<string, unknown>;
  /** 项目级 agent 池 */
  agents: AgentConfig[];
  /** 全局 agent 池 */
  globalAgents?: AgentConfig[];
  /** 项目路由表 */
  routeTable?: AgentRouteTable;
  /** 项目默认 agent */
  defaultAgentId?: string | null;
  /** 目标工作流名（goal 特征） */
  goal: string;
  /** projectId（成功率统计） */
  projectId?: string;
}

/** 决策结果：路由决策 + 是否经历路由 + 日志文案。 */
export interface AgentDecisionResult {
  decision: RouterDecision;
  /** 是否经历了路由（reason≠explicit） */
  routed: boolean;
  /** 可用候选池（供 fallback 循环 byId） */
  mergedAgents: AgentConfig[];
  /** 路由日志（routed 时非空） */
  routeLog: string;
}

/** 执行 AgentRouter 决策（纯函数：所有输入显式传入，无 store 依赖）。 */
export function decideAgentCall(input: AgentDecisionInput): AgentDecisionResult {
  const {
    requestedAgentId,
    typeId,
    params,
    agents,
    globalAgents,
    routeTable,
    defaultAgentId,
    goal,
    projectId,
  } = input;

  // 合并项目级 ∪ 全局（项目级同名覆盖全局），过滤禁用
  const mergedAgents = [...(globalAgents ?? [])]
    .filter((a) => !agents.some((pa) => pa.id === a.id))
    .concat(agents)
    .filter((a) => a.enabled !== false);

  const category =
    typeof params?.category === 'string' && params.category.trim()
      ? params.category.trim()
      : undefined;

  const scoringInput = {
    agentId: requestedAgentId ?? undefined,
    typeId,
    category,
    textLength: goal.length,
    scopeSize: Array.isArray(params?.scope) ? (params.scope as unknown[]).length : undefined,
  };
  const decision = resolveAgentScored(scoringInput, {
    agents: mergedAgents,
    routeTable: routeTable ?? {},
    defaultAgentId: defaultAgentId ?? null,
  }, {
    successByAgent: successRateByAgent(projectId ?? ''),
  });

  const routed = decision.routed;
  const bestScore = decision.scores?.[0];
  // 路由日志（供调用方拼节点 label）：智能体<id>经 AgentRouter 成本感知路由到「<agent.name>」（...）
  const routeLog = routed
    ? `智能体${requestedAgentId ? ` ${requestedAgentId}` : '未指定'}经 AgentRouter 成本感知路由到「${decision.agent.name}」（${decision.reason}${category ? `，类别 ${category}` : ''}${bestScore ? `，评分 ${bestScore.score.toFixed(2)}` : ''}）`
    : '';

  return { decision, routed, mergedAgents, routeLog };
}
