import type { AssetMeta } from './types/project';
export type { AssetMeta, RecentProject } from './types/project';
export type { CapabilityLevel } from './types/capability';
export type { LoadedPlugin, PluginManifest, PluginNodeMeta, PluginOccupation } from './types/plugin';

import type { ProjectControlSnapshot } from './projectControl/types';
import type {
  EdgeKind,
  FlowEdge,
  FlowNode,
  PortType,
} from './types/graph';

import type {
  AgentConfig,
  RoleTemplate,
} from './types/agent';
export type {
  AgentConfig,
  AntigravityMode,
  ApiEndpoint,
  ApiVault,
  ChatMessage,
  ContentPart,
  ContextScope,
  CostLedger,
  CostRecord,
  ExecLogger,
  LLMResponse,
  LLMToolSpec,
  Protocol,
  RoleTemplate,
  TokenUsage,
  ToolCall,
  Vendor,
} from './types/agent';
export { EDGE_KIND_STYLE, arePortsCompatible } from './types/graph';
export type {
  EdgeKind,
  FlowEdge,
  FlowEdgeData,
  FlowNode,
  NodeStatus,
  NodeUsageStat,
  ParamDef,
  ParamType,
  PortDef,
  PortType,
  WorkflowNodeData,
} from './types/graph';


import type {
  Orchestration,
  PipelineDef,
  ProjectArtifacts,
} from './types/orchestration';
export type {
  Artifact,
  ArtifactKind,
  DraftEdge,
  DraftStage,
  Orchestration,
  OrchestrationStatus,
  PipelineDef,
  PipelineDraft,
  PipelineEdge,
  PipelineStage,
  ProjectArtifacts,
  StageLog,
} from './types/orchestration';
import type { RunRecord } from './types/execution';
export type { LogEntry, RunNodeResult, RunRecord } from './types/execution';
export { NODE_ROLE_META, createNodeDef } from './types/node';
export type {
  ExecContext,
  InterventionRequest,
  InterventionResult,
  NodeDefInput,
  NodeDefinition,
  NodeExecuteFn,
  NodeRole,
  SandboxHandle,
} from './types/node';

/* ---------- 任务派发协议（Dispatcher / Coordinator） ---------- */
/** 一个被派发的任务单元。
 * - label：任务名（供 Coordinator / Auditor 展示）
 * - scope：影响域声明（涉及的文件 / 接口 / 抽象类），供 Conflict Resolver 做并发冲突检测
 * - payload：任务实际内容（文本 / 结构化数据），由下游 Builder 消费
 * 约定：scope 走数据协议（任务对象自带），不依赖引擎改动，便于框架先行落地。 */
export interface TaskItem {
  label: string;
  scope?: string[];
  payload?: unknown;
  /** 上游派发节点赋予的序号，便于追踪 */
  index?: number;
}

/** 架构师产出的模块/组件设计单元。
 * 与 TaskItem 字段兼容（label/scope/payload），因此架构输出可直接喂给「任务派发」节点。
 * - name：模块名
 * - responsibility：职责说明（作为 label 展示）
 * - scope：影响域（涉及的文件/接口/抽象类），供 Conflict Resolver 做并发冲突检测
 * - dependsOn：依赖的其它模块名（用于拓扑排序/施工顺序提示）
 * - payload：模块设计详情（文本/结构化），由下游 Builder 消费 */
export interface ModuleItem {
  name: string;
  responsibility?: string;
  scope?: string[];
  dependsOn?: string[];
  payload?: unknown;
  index?: number;
  /** 步骤 14.7：模块类别（如 ui/logic/docs/infra），供 Builder 经路由表绑定 agent/模型。
   * 架构师节点（architect.design）生成模块时标注；Builder（14.F）据此从路由表查 agentId。 */
  category?: ModuleCategory;
  /** 步骤 14.7：显式指定该模块使用的智能体 id（优先级高于 category 路由）。
   * 为空时 Builder 按 category 走项目级路由表。 */
  agentId?: string;
}

/** 模块类别枚举（步骤 14.7，对标 oh-my-openagent 的 category 解耦路由）。
 * 仅作约定值，路由表键可扩展为任意字符串。 */
export type ModuleCategory =
  | 'ui' //      前端/视觉/界面
  | 'logic' //   核心逻辑/算法/架构
  | 'docs' //    文档/文本/说明
  | 'infra' //   构建/部署/配置/工程化
  | 'data' //    数据/存储/接口契约
  | string; //   预留：自定义类别

/** 步骤 14.7：模块类别 → 智能体 id 的路由表项（单条）。 */
export interface AgentRouteEntry {
  /** 该类别默认绑定的智能体 id（对应 AgentConfig.id）。 */
  agentId: string;
  /** 回退链：主 agent 不可用时依次尝试的 agent id 列表（对标 oh-my-opencode-slim 的 Model Fallback Chain）。 */
  fallback?: string[];
}

/** 步骤 14.7：项目级「类别 → agent」路由表。键为 ModuleCategory（小写），值为路由项。
 * 随项目 .slimemold 持久化，用户可在设置/Inspector 中覆写（对齐 OMO 的「配置可覆写」哲学）。 */
export type AgentRouteTable = Record<string, AgentRouteEntry>;

/* ---------- 文件补丁与冲突协调（步骤 11 沙箱式并行） ---------- */
/** 单条文件改动补丁（逻辑层模拟沙箱，无需真实文件系统隔离）。
 * - path：受影响文件相对路径
 * - before：读取时的原始内容（null 表示新建文件）
 * - after：任务线写入后的内容
 * - readSnapshot：读取时的快照哈希/行区间（借鉴 OMO Hashline，用于合并前精准识别陈旧编辑）
 *   - hash：before 内容的哈希；若别人已动同一处（after 基于旧版本），合并时标记需仲裁
 *   - lineRange：[start,end] 行区间，缺省视为整文件
 *   - source：scope 来源（对应步骤 11.1 并存/剪枝预留）：'object' | 'edge' | 'both' */
export interface FilePatch {
  path: string;
  before: string | null;
  after: string;
  readSnapshot?: {
    hash?: string;
    lineRange?: [number, number];
    source?: 'object' | 'edge' | 'both';
  };
}

/** 协调者合并产物：无逻辑冲突时把多方改动汇总为「同一文件」的最终补丁集。 */
export interface MergeResult {
  /** 可直接合并（文本区间不重叠）的补丁，按 path 汇总 */
  patches: FilePatch[];
  /** 需要人工/council 仲裁的补丁（同一 path 的 after 互相覆盖、或 readSnapshot 提示陈旧编辑） */
  needsArbitration: Array<{ path: string; candidates: FilePatch[] }>;
  /** scope 来源标注（对应步骤 11.1） */
  sources: Array<'object' | 'edge' | 'both'>;
}

/** Council 仲裁裁决结果（对应 OMO-slim Council 合成 single verdict 范式）。 */
export interface CouncilVerdict {
  /** 最终合成裁决（文本） */
  verdict: string;
  /** 各议员（并行评估子节点）独立回复 */
  councillors: Array<{ name: string; reply: string; failed?: boolean }>;
  /** 共识评级（对应 OMO-slim 的 unanimous/majority/split） */
  consensus: 'unanimous' | 'majority' | 'split';
  /** 是否部分议员失败但成功合成 */
  partialFailure: boolean;
}

/* ---------- 工作流文件 ---------- */
export interface WorkflowFileNode {
  id: string;
  typeId: string;
  label: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  /** 节点旁路开关（对齐运行态 data.bypass，旧文件缺省视为 false） */
  bypass?: boolean;
  /** 节点静音开关（对齐运行态 data.mute，旧文件缺省视为 false） */
  mute?: boolean;
  /** 画布选中态（运行时态，存盘忽略，仅类型兼容） */
  selected?: boolean;
}

export interface WorkflowFileEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  /** 连线语义（data/task/control），缺省 'data'，向后兼容旧工作流文件 */
  kind?: EdgeKind;
  /** task 连线的派发影响域声明（与 FlowEdgeData.scope 对应），供「冲突协调者」检测并发冲突 */
  scope?: string[];
  /** 画布选中态（运行时态，存盘忽略，仅类型兼容） */
  selected?: boolean;
}

export interface WorkflowFile {
  version: 1;
  name: string;
  savedAt: string;
  nodes: WorkflowFileNode[];
  edges: WorkflowFileEdge[];
  agents: AgentConfig[];
  /** 角色库（随工作流保存/加载），内置角色以 builtin=true 标记 */
  roles?: RoleTemplate[];
  /** 全局变量（随工作流一起保存/加载） */
  variables?: Record<string, unknown>;
  /**
   * 工作区目录（绝对路径）。
   * - null/undefined：未创建工作区，写文件节点产物落到工作流内部目录，随工作流删除销毁。
   * - 字符串：用户指定的文件夹，写文件产物落到此处。
   */
  workspaceDir?: string | null;
  /** 本工作流产出的资产（文件/预览）元数据，用于左侧「资产」面板的预览与导出 */
  assets?: AssetMeta[];
  /** 节点组（纯视觉编组，不参与执行） */
  groups?: NodeGroup[];
  /**
   * 归属声明（游离工作流 vs 项目内工作流）：
   * - 属于某项目时填 `belongsToProject`（项目 id），资产/变量作用域走项目级；
   * - 游离工作流填 `standalonePath`（磁盘绝对路径，单文件存盘位置），仅工作流级作用域。
   * 两者至多其一。缺失即视为游离且尚未存盘（路径未知）。
   */
  belongsToProject?: string;
  standalonePath?: string;
  /** 工作流默认智能体（节点未指定 roleId 时使用；null 表示未设置） */
  defaultAgentId?: string | null;
  /** 人类可读的配置/使用说明（示例文件常见；运行时忽略，仅供阅读与导入后展示） */
  notes?: string;
  /** 运行历史（P2 成本跟项目：落盘到 .slimemold/runs/history.json） */
  runs?: { history: RunRecord[] };
}

/**
 * 内存态工作流：节点/边与画布运行态同构（FlowNode/FlowEdge），
 * 便于所有 store 方法（含非激活工作流）直接读写 data.* 字段。
 * 落盘时由 toDisk() 拍平回 WorkflowFile（剥离 measured/dragging 等瞬态）。
 */
export interface WorkflowFileInMemory extends Omit<WorkflowFile, 'nodes' | 'edges'> {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/* ---------- 子图（可复用节点组合） ---------- */

/** 子图对外暴露的一个端口。
 * 由子图内部某个节点的某个端口「提升」而来：外部连到该端口的数据，
 * 在扁平化展开时会被直接接到 innerNodeId/innerHandle 上。 */
export interface SubgraphPort {
  /** 端口 id（子图引用节点上的 handle id），如 'in_1' */
  id: string;
  /** 端口显示名 */
  label: string;
  type?: PortType;
  /** 内部承接该端口的节点 id */
  innerNodeId: string;
  /** 内部节点上的 handle id */
  innerHandle: string | null;
}

/** 子图定义：一组节点+连线的可复用封装。
 * 存放在项目级 subgraphs 字典中，被 subgraph.ref 节点通过 subgraphId 引用。 */
export interface SubgraphDef {
  id: string;
  name: string;
  description?: string;
  /** 节点库中的分组（用于左侧面板归类） */
  category?: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowFileNode[];
  edges: WorkflowFileEdge[];
  /** 对外输入端口（内部未被连接的输入端口自动提升） */
  inputs: SubgraphPort[];
  /** 对外输出端口（内部未被连接的输出端口自动提升） */
  outputs: SubgraphPort[];
}

/* ---------- 节点组（升级为子图引用） ---------- */

/** 聚合代理端口：按「端口类型」合并子图内部同类端口。
 * - 折叠态分组标签按聚合端口生成虚拟端口（外部多对一、内部一对多）。
 * - 例：子图内部共需 2×img + 1×txt 输入 -> 仅生成 img、txt 两个聚合端口。 */
export interface ProxyPort {
  /** 稳定 id，如 `${groupId}:in:img` / `${groupId}:out:text` */
  id: string;
  kind: 'input' | 'output';
  /** 聚合类型（取内部同类端口的类型，缺省 'any'） */
  type?: PortType;
  /** 显示名，如 'img' / 'txt' */
  label: string;
  /** 内部一对多：该聚合端口分发到的子图内部目标（节点端口）。
   * - input 代理：外部数据广播给这些内部输入端口
   * - output 代理：这些内部输出端口汇聚到该代理端口 */
  internalTargets: Array<{ nodeId: string; portId: string }>;
}

/** 虚拟边：聚合代理端口 -> 多个内部端口的一对多映射（Q10=A）。
 * 渲染时按 targets 展开成多条实际连线；执行时数据广播给所有目标。 */
export interface VirtualEdge {
  id: string;
  /** 子图侧聚合代理端口 id（如 `${groupId}:in:img`） */
  proxyPortId: string;
  kind: 'input' | 'output';
  /** 内部一对多目标（节点端口） */
  targets: Array<{ nodeId: string; portId: string }>;
}

/** 节点组：把若干节点框在一起，可整体拖动 / 折叠 / 配色。
 * 现升级为「子图引用」：折叠时对外呈现聚合代理端口，双击进入子图编辑视图。 */
export interface NodeGroup {
  id: string;
  title: string;
  /** 组内成员节点 id（= 子图内部节点） */
  nodeIds: string[];
  /** 组框颜色（CSS 颜色值） */
  color: string;
  /** 是否折叠（折叠时组内节点隐藏，仅显示聚合代理端口卡片） */
  collapsed: boolean;
  /** 折叠前记录的组框区域，用于折叠态占位与展开还原 */
  bounds?: { x: number; y: number; width: number; height: number };
  /** 关联的子图定义 id（分组即子图，新建分组时自动生成空子图） */
  subgraphId?: string;
  /** 折叠态聚合代理端口（按类型合并，自动推导内部端口类型并集） */
  proxyPorts?: ProxyPort[];
  /** 内部一对多虚拟边（聚合端口 -> 内部端口映射） */
  virtualEdges?: VirtualEdge[];
}

/* ---------- 项目文件（.smproj，含多个工作流） ---------- */
export interface ProjectFile {
  version: 1;
  kind: 'project';
  /** 项目唯一 id（由 createProjectFile 生成），工作流通过 belongsToProject 反向引用 */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 项目内工作流集合，key 为工作流 id */
  workflows: Record<string, WorkflowFile>;
  /** 当前激活的工作流 id */
  activeId: string;
  /** 角色库（项目级，跨工作流共享），内置角色以 builtin=true 标记 */
  roles?: RoleTemplate[];
  /** 项目级全局变量（工作流级 variables 覆盖同名项） */
  variables?: Record<string, unknown>;
  /** 项目级资产库（跨工作流共享；工作流级 assets 覆盖同名 id 后并入） */
  assets?: AssetMeta[];
  /** 项目级子图库（可复用节点组合），key 为子图 id */
  subgraphs?: Record<string, SubgraphDef>;
  /** 项目级资产/产物库（构建产物、导出物等元数据），供后续步骤/报告引用 */
  artifacts?: ProjectArtifacts;
  /** 旧版单文件 .smproj 兼容标记（由单文件迁移到目录形态后置 true） */
  legacy?: boolean;
  /** 项目级「类别 → agent」路由表（Builder 生成施工方工作流时绑定 agent 用） */
  agentRouteTable?: AgentRouteTable;
  /**
   * 项目级智能体（跨工作流共享，2026-08-10 起从「随单个工作流」提升为项目级）。
   * 持久化到 `.slimemold/agents.json`；加载时优先读此文件，旧版本内联在 workflow 的 agents 作为兼容合并。
   */
  agents?: AgentConfig[];
  /** 项目级默认智能体 id（工作流未指定 agent 时引用） */
  defaultAgentId?: string | null;
  /** 项目级 Pipeline 定义集合（跨工作流三方协作编排的阶段与流向），随 .slimemold 持久化 */
  pipelines?: PipelineDef[];
  /** 项目级编排记录（草案、阶段绑定、运行进度和失败信息），随 .slimemold 持久化 */
  orchestrations?: Orchestration[];
  /** 项目级 Worker Run queue registry（状态可恢复，随 project.json 持久化） */
  workerRuns?: import('./domain/workerQueue').WorkerRunQueueState[];
  /** 项目控制面快照（主控会话、Decision、Issue 和版本化 Brief），随 .slimemold 持久化 */
  projectControl?: ProjectControlSnapshot;
  /** 项目级运行历史（持久化） */
  runs?: { history: RunRecord[] };
  /** 运行检查点（阶段 C 可恢复执行）：按 wfId 覆盖式存储最近一次运行的节点级结果，随项目落盘 */
  checkpoints?: Record<string, import('./engine/checkpoint').RunCheckpoint>;
  /** 检查点多版本历史（阶段 G2）：按 wfId 保留最近 N 条运行快照 */
  checkpointHistory?: Record<string, import('./engine/checkpoint').RunCheckpoint[]>;
}
