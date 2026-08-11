/**
 * H3 Orchestrator —— 草案生成（纯函数，零副作用）。
 *
 * 设计约束（docs/H3_ORCHESTRATOR_DESIGN.md §6）：
 * - generateDraft 是只读操作：不写 store、不落盘、不注册工作流；
 * - 只用 AgentRouter（decideAgentCall）选「每阶段谁负责」；
 * - 阶段模板先硬编码（MVP），H3d 再接入 LLM 生成。
 */

import type { AgentConfig, AgentRouteTable, ArtifactKind } from '../types';
import { decideAgentCall } from '../agents/agentDecision';
import type { OrchestratorRequest, PipelineDraft } from './types';

/** 阶段模板：把任意目标映射为「计划 → 实施 → 验收」三段（MVP 硬编码） */
const STAGE_TEMPLATE: Array<{
  id: string;
  label: string;
  role: 'builder' | 'constructor' | 'ops';
  goalSuffix: string;
  artifactOut: string[];
  artifactIn: string[];
}> = [
  {
    id: 'plan',
    label: '计划',
    role: 'builder',
    goalSuffix: '制定可落实的实施计划：拆解目标、明确任务清单与验收标准',
    artifactOut: ['plan'],
    artifactIn: [],
  },
  {
    id: 'construction',
    label: '实施',
    role: 'constructor',
    goalSuffix: '按计划执行：完成任务、产出可运行的实现',
    artifactOut: ['project'],
    artifactIn: ['plan'],
  },
  {
    id: 'acceptance',
    label: '验收',
    role: 'ops',
    goalSuffix: '验收实现是否达成目标：检查完整性、收集问题并报告',
    artifactOut: ['bugreport'],
    artifactIn: ['project'],
  },
];

/** generateDraft 输入依赖（只读 store 视图，保持零副作用） */
export interface DraftDeps {
  agents: AgentConfig[];
  globalAgents?: AgentConfig[];
  routeTable?: AgentRouteTable;
  defaultAgentId?: string | null;
  projectId?: string;
}

/** 生成 DAG 草案（纯函数：只返回 PipelineDraft，不写任何状态） */
export function generateDraft(
  request: OrchestratorRequest,
  deps: DraftDeps,
): PipelineDraft {
  const maxStages = request.constraints?.maxStages ?? STAGE_TEMPLATE.length;
  const template = STAGE_TEMPLATE.slice(0, Math.min(maxStages, STAGE_TEMPLATE.length));

  const stages = template.map((t) => {
    // 用 AgentRouter 决策该阶段绑定的 agent（复用 decideAgentCall）
    const decision = decideAgentCall({
      requestedAgentId: request.constraints?.agentId,
      typeId: `orch.${t.id}`,
      params: {},
      agents: deps.agents,
      globalAgents: deps.globalAgents,
      routeTable: deps.routeTable,
      defaultAgentId: deps.defaultAgentId,
      goal: `${request.goal}。${t.goalSuffix}`,
      projectId: deps.projectId,
    });
    return {
      id: t.id,
      label: t.label,
      role: t.role,
      goal: `${request.goal}。${t.goalSuffix}`,
      wfRef: { kind: 'new' as const },
      agentId: decision.decision.agent.id,
      artifactIn: t.artifactIn as ArtifactKind[],
      artifactOut: t.artifactOut as ArtifactKind[],
    };
  });

  // 串行边：plan → construction → acceptance
  const edges = stages.slice(0, -1).map((s, i) => ({
    from: s.id,
    to: stages[i + 1].id,
    artifactKind: STAGE_TEMPLATE[i].artifactOut[0],
  }));

  return { stages, edges };
}
