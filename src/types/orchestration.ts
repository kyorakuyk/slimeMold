/**
 * Project-level orchestration and delivery contracts.
 * Pure types only; no store, engine, or host dependencies.
 */
/* ---------- Pipeline / Artifact（跨工作流三方协作，G5 上提自 engine/pipeline） ---------- */

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

/**
 * 项目级交付物存储：按「阶段 → 种类 → Artifact」组织。
 * 阶段（stage）对应 pipeline 的节点式生命周期（idea/plan/design/construction/test/deliver/ops）。
 * 同一阶段可有多种 kind（如 construction 阶段既有 project 又有 bugreport 回流）。
 */
export type ProjectArtifacts = Record<string, Record<string, Artifact>>;

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

/* ---------- H3 Orchestrator（总控 Agent，只生成草案不静默改用户工作流） ---------- */

/**
 * 编排状态机。
 * 生命周期：draft → awaiting-confirm → ready（确认后待执行）→ running（仅 runOrchestration 进入）
 *          → done / failed / cancelled / paused（可恢复回 running）
 * 注意：confirmDraft 只把状态置为 ready，绝不进入 running——「确认」≠「执行」。
 */
export type OrchestrationStatus =
  | 'draft'
  | 'awaiting-confirm'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'failed';

/** 草案阶段（未绑定 wfId） */
export interface DraftStage {
  id: string;
  label: string;
  role: 'builder' | 'constructor' | 'ops';
  /** 该阶段子目标 */
  goal: string;
  /** 建议绑定的工作流：新生成 或 复用已有（只读引用） */
  wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string };
  /** 来源任务图（供控制面与高级 DAG 互相追溯） */
  sourceTaskGraphId?: string;
  /** 该阶段负责的项目任务 id */
  taskIds?: string[];
  /** AgentRouter 决策结果（选哪个 agent） */
  agentId?: string;
  /** 需要的上游产物 */
  artifactIn?: ArtifactKind[];
  /** 产出的交付物 */
  artifactOut?: ArtifactKind[];
}

/** 草案边（有向） */
export interface DraftEdge {
  from: string; // stageId
  to: string;   // stageId
  artifactKind: ArtifactKind;
  backflow?: boolean;
}

/** DAG 草案（纯数据，不落盘） */
export interface PipelineDraft {
  stages: DraftStage[];
  edges: DraftEdge[];
}

/** 每阶段执行记录 */
export interface StageLog {
  stageId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  wfId?: string;
  /** 真实运行 id（executor runId 数字代次；兼容历史字符串形态） */
  runId?: string | number;
  cost?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** 一次编排（存项目态 orchestrations 字段，随 .slimemold 持久化） */
export interface Orchestration {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  createdAt: string;
  updatedAt: string;
  /** DAG 草案（确认前不变更用户工作流） */
  draft: PipelineDraft | null;
  /** 确认后生成的 pipeline 定义 id */
  pipelineId?: string;
  /** 当前执行到哪一阶段（可恢复） */
  cursor?: string;
  /** 只读模式：只产出草案不执行（constraints.readonly 固化到编排记录，运行路径无需 getRequest） */
  readonly?: boolean;
  /** 阶段 → 真实 wfId 固化映射（首次绑定后写入，恢复/重试复用同一工作流，不重建） */
  stageWfIds?: Record<string, string>;
  stageLogs: StageLog[];
  /** 每个 Worker Run 独立的阶段投影；stageLogs 是当前 activeRunId 的便捷视图。 */
  stageLogsByRun?: Record<string, StageLog[]>;
  activeRunId?: string | number;
  /** 关联运行 id（runEvents 重放；executor runId 数字代次） */
  runIds: (string | number)[];
}
