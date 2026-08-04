/**
 * 步骤 14.A：跨工作流三方协作编排 —— Pipeline Orchestrator 地基。
 *
 * 设计约束（来源 TODO 14.0 / 14.2）：
 * - 这是「站在 executor 外面」的协调层，**不重写 executor**，每个工作流仍各自 `runWorkflow` 跑。
 * - 只描述「工作流之间的边」（阶段与流向），不碰工作流内部的 topoSort / 成环检测。
 * - 交付物（Artifact）是一等公民，存于 workflowStore 项目态（随 .slimemold 持久化）。
 *
 * 本文件只放「类型 + 纯函数 + 与 store 的薄交互」。编排触发（真正调 runWorkflow）留在
 * 14.B（边界节点）/ 14.F（Builder）/ 14.E（回流边）接入，避免一次性改动过大。
 */

import type { ModuleItem } from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { getActiveRunId } from './executor';

/* ===================== 交付物（Artifact） ===================== */

/** 交付物种类：对应承建方→施工方→物业 三方的有结构传递物（见 TODO 14.1）。 */
export type ArtifactKind =
  | 'plan' //      承建方：dispatch.plan 的计划书 + 任务清单
  | 'design' //    承建方：architect.design 的设计书 + 模块清单
  | 'project' //   施工方：装配完整的项目（代码 + 结构 + 验收报告）
  | 'bugreport' // 物业：运维期收集的 bug 报告
  | 'constructionWf' // Builder 生成的施工方工作流 JSON
  | 'opsWf' //      Builder 生成的物业运维工作流 JSON
  | string; //      预留：自定义种类

/** 交付物：跨工作流传递的有类型包裹（不塞进黑板字符串，复用现有 TaskItem/ModuleItem/FilePatch 等类型）。 */
export interface Artifact {
  kind: ArtifactKind;
  /** 负载：结构化数据（plan/text/design/modules/project/bugreport…），由消费方按 kind 解释。 */
  payload: unknown;
  /** 来源工作流 id（谁产出的）。 */
  fromWf: string;
  /** 产出时的运行代次（executor.currentRunId 的快照），用于新鲜度判断。 */
  runId: string;
  /** 该种类下的版本号，每次覆盖同一 (stage, kind) 自增，便于消费方判断「是否更新」。 */
  version: number;
  /** 产出时间戳（ISO 字符串），用于 UI 显示「数据来自 X 前」。 */
  updatedAt: string;
}

/* ===================== 项目级黑板（Project Artifacts） ===================== */

/**
 * 项目级交付物存储：按「阶段 → 种类 → Artifact」组织。
 * 阶段（stage）对应 pipeline 的节点式生命周期（idea/plan/design/construction/test/deliver/ops）。
 * 同一阶段可有多种 kind（如 construction 阶段既有 project 又有 bugreport 回流）。
 */
export type ProjectArtifacts = Record<string, Record<string, Artifact>>;

/* ===================== Pipeline 定义（阶段与流向） ===================== */

/**
 * 阶段定义：pipeline 的一个「职能节点」（对应承建方/施工方/物业 等职能角色）。
 * 注意：stage 不是图内节点，而是「工作流」级别的概念——每个 stage 绑定一个工作流 id。
 */
export interface PipelineStage {
  /** 阶段 id（如 'plan' / 'design' / 'construction' / 'ops'）。 */
  id: string;
  /** 人类可读名。 */
  label: string;
  /** 绑定的工作流 id（来自 workflowStore.workflows）。Builder 生成后由 Orchestrator 回填。 */
  wfId?: string;
  /** 职能分类（承建方/施工方/物业），仅 UI 着色用。 */
  role?: 'builder' | 'constructor' | 'ops';
}

/** 有向边：upstream 阶段完成后，把产物交给 downstream 阶段。 */
export interface PipelineEdge {
  from: string; // stage id
  to: string; //   stage id
  /** 该边传递的 Artifact kind（决定 advance 时从上游取哪种产物传给下游）。 */
  artifactKind: ArtifactKind;
  /**
   * 回流标记：true 表示这是「回流边」（如 council 裁决 → design 决断 → 重派），
   * 不计入正向主流程，仅 rework() 时触发，避免主流程成环。
   */
  backflow?: boolean;
}

/** 一条 pipeline 定义：阶段集合 + 有向边集合。 */
export interface PipelineDef {
  id: string;
  label: string;
  stages: PipelineStage[];
  edges: PipelineEdge[];
}

/* ===================== 与 store 的薄交互 ===================== */

/**
 * 读取整个项目级交付物表（不触发渲染更新，供引擎内部读取）。
 */
export function getArtifacts(): ProjectArtifacts {
  return useWorkflowStore.getState().artifacts ?? {};
}

/**
 * 读取某阶段某种类的最新交付物（不存在返回 undefined）。
 */
export function getArtifact(stage: string, kind: ArtifactKind): Artifact | undefined {
  return getArtifacts()[stage]?.[kind];
}

/**
 * 写入一份交付物到项目级存储。
 * - 走 workflowStore.setArtifact（store 方法），自动触发 projectDirty 与持久化。
 * - 同一 (stage, kind) 覆盖时 version 自增，记录 runId/updatedAt。
 * 返回写入后的 Artifact（含新 version）。
 */
export function publishArtifact(args: {
  stage: string;
  kind: ArtifactKind;
  payload: unknown;
  fromWf: string;
  runId: string;
}): Artifact {
  const st = useWorkflowStore.getState();
  const prev = st.artifacts?.[args.stage]?.[args.kind];
  const artifact: Artifact = {
    kind: args.kind,
    payload: args.payload,
    fromWf: args.fromWf,
    runId: args.runId,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  st.setArtifact(args.stage, args.kind, artifact);
  return artifact;
}

/**
 * 声明/注册一条 pipeline（仅存储定义，不立即执行）。
 * 目前只做内存登记（pipelineDefs 暂存于模块级，待 14.B 接入 store 持久化）。
 */
const pipelineDefs = new Map<string, PipelineDef>();

export function definePipeline(def: PipelineDef): PipelineDef {
  pipelineDefs.set(def.id, def);
  return def;
}

export function getPipeline(id: string): PipelineDef | undefined {
  return pipelineDefs.get(id);
}

/**
 * 把某阶段绑定的工作流 id 回填（Builder 生成后调用）。
 */
export function bindStageWorkflow(pipelineId: string, stageId: string, wfId: string): void {
  const def = pipelineDefs.get(pipelineId);
  if (!def) return;
  def.stages = def.stages.map((s) => (s.id === stageId ? { ...s, wfId } : s));
}

/**
 * advance：上游阶段完成后，取指定 kind 的产物，写入下游阶段对应的交付物槽位。
 * 这里只做「产物落盘 + 返回下游阶段定义」，真正触发下游 runWorkflow 留给调用方（14.B/14.E），
 * 以保持本文件对 executor 的零依赖。
 *
 * @returns 受影响的下游阶段（可能多个，因同一 kind 可流向多条边），供调用方决定触发哪些工作流。
 */
export function advance(
  pipelineId: string,
  upstreamStage: string,
  artifactKind: ArtifactKind,
): PipelineStage[] {
  const def = pipelineDefs.get(pipelineId);
  if (!def) return [];
  const artifact = getArtifact(upstreamStage, artifactKind);
  if (!artifact) return [];
  const targets: PipelineStage[] = [];
  for (const edge of def.edges) {
    if (edge.from === upstreamStage && edge.artifactKind === artifactKind && !edge.backflow) {
      const target = def.stages.find((s) => s.id === edge.to);
      if (target) {
        publishArtifact({
          stage: target.id,
          kind: artifactKind,
          payload: artifact.payload,
          fromWf: artifact.fromWf,
          runId: artifact.runId,
        });
        targets.push(target);
      }
    }
  }
  return targets;
}

/**
 * rework：回流场景。上游阶段因冲突/bug 需要重做时，把裁决/报告作为新产物写入上游阶段，
 * 并通知调用方重跑该阶段绑定的工作流（增量或全量由调用方决定）。
 *
 * @returns 需要重跑的阶段（通常是 edge.to 指向的上游阶段本身，或经 backflow 边指定的目标）。
 */
export function rework(
  pipelineId: string,
  targetStage: string,
  artifactKind: ArtifactKind,
  payload: unknown,
  fromWf: string,
  runId: string,
): PipelineStage | undefined {
  const def = pipelineDefs.get(pipelineId);
  if (!def) return undefined;
  const target = def.stages.find((s) => s.id === targetStage);
  if (!target) return undefined;
  // 回流产物写入目标阶段（覆盖旧值，version 自增）
  publishArtifact({ stage: targetStage, kind: artifactKind, payload, fromWf, runId });
  return target;
}

/* ===================== Builder 消费侧的模块结构提示 ===================== */

/**
 * 给 Builder 节点（14.F）消费的模块类型再导出，避免其单独 import types。
 * ModuleItem 来自 architect.design 输出，Builder 据其生成施工方工作流。
 */
export type { ModuleItem };

/* ===================== 节点友好封装 ===================== */

/**
 * 节点侧发布 Artifact 的便捷入口：自动填充 `fromWf`（当前活动工作流 id）
 * 与 `runId`（executor 当前运行代次快照）。节点只需关心 stage / kind / payload。
 *
 * 该封装让「architect.design / coord.council / builder.generate」等协作节点
 * 无需直接依赖 store 与 runId 来源，统一走 pipeline 层，便于以后把 stage 从
 * 节点参数迁移到 executor 注入的元数据（14.B 编排触发时）。
 */
export function publishArtifactFromNode(args: {
  stage: string;
  kind: ArtifactKind;
  payload: unknown;
}): Artifact {
  const st = useWorkflowStore.getState();
  const fromWf = st.activeWfId ?? '';
  const runId = String(getActiveRunId() || 0);
  return publishArtifact({ stage: args.stage, kind: args.kind, payload: args.payload, fromWf, runId });
}
