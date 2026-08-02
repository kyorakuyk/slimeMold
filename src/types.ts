import type { Node, Edge } from '@xyflow/react';

/* ---------- 节点状态与协议 ---------- */
export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'cached' | 'skipped';
export type Protocol = 'openai' | 'anthropic' | 'ollama';

/* ---------- API 接入点（APIKEYS 分区集中管理的「网址 + 密钥」） ---------- */
/** 一个 API 接入点：把 Base URL 与密钥绑定成可复用的配置单元（类似 cc-switch 的 API 路由）。
 * - name：唯一标识，也作为系统密钥库的条目键（实际存 `ep::<name>`）。
 * - 密钥明文仅存系统密钥库；此结构不持久化明文（运行时从密钥库取回）。 */
export interface ApiEndpoint {
  name: string;
  protocol: Protocol;
  /** 中转站 / 官方 Base URL，如 https://apinebula.ai/v1 */
  baseUrl: string;
  /** 系统密钥库中的凭据键（= name）。智能体可经此键引用，无需重复填 key。 */
  credentialKey: string;
}

/* ---------- 智能体配置 ---------- */
export interface AgentConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** 明文 apiKey：仅在 headless / 本地 Ollama（无需 key）场景下使用。
   *  桌面生产链路应通过 credentialKey 从系统密钥库取，UI 不编辑此字段。 */
  apiKey?: string;
  /** 系统密钥库中的凭据键；非空时 Rust 侧按此从 OS 密钥库取回真实 key（Step 0.5）。
   *  工作流文件只存此键，绝不存明文 key。 */
  credentialKey?: string;
  model: string;
  temperature?: number;
  /** 绑定的角色（角色库 id）。节点可通过角色快速获得预设提示词与默认模型，可被节点级覆写 */
  roleId?: string;
  /** 供应商预设 id（如 'deepseek' / 'siliconflow' / 'openrouter' / 'custom'），
   *  仅用于 UI 展示与默认 Base URL 记忆，不影响运行时链路 */
  providerId?: string;
  /** 本地代理转发地址（参考 cc-switch 的本地代理路由）。
   * 非空时经该代理访问 Base URL，适配中转/OpenAI 格式统一。
   * backend 通道（Rust reqwest）与 frontend 通道（plugin-http proxy 选项）均已生效。 */
  proxyUrl?: string;
}

/** 角色上下文隔离粒度：
 * - 'shared'：与其它节点共享全局变量 / 会话历史（默认）
 * - 'isolated'：该角色节点持有独立上下文，不向全局 vars 写回、不污染其它节点 */
export type ContextScope = 'shared' | 'isolated';

/** 角色模板（角色库条目）。
 * 预设系统提示词 + 推荐模型/协议，作为 Agent 的"职业"抽象层。
 * extendId 预留角色继承扩展点（后期实现，当前未使用）。 */
export interface RoleTemplate {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  /** 角色系统提示词（设定职业、职责、输出规范） */
  system: string;
  /** 角色推荐协议 / 模型，作为节点级模型选择的默认值（可被覆写） */
  protocol?: Protocol;
  model?: string;
  contextScope?: ContextScope;
  /** 预留：继承自某个基础角色（后期实现继承链） */
  extendId?: string;
  /** 内置预设角色标记，用户不可删除 */
  builtin?: boolean;
}

/** 多模态消息内容片段（对齐 OpenAI / Anthropic vision 结构）。
 * - text：纯文本段
 * - image：图片段，url 为 data URL（data:image/png;base64,…）或 https 链接 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mediaType?: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 文本消息为 string；多模态（图生文）消息为内容片段数组 */
  content: string | ContentPart[];
}

/* ---------- 节点定义 ---------- */
/** 端口数据类型。用于连线时的类型校验，避免「把 list 接到只收 text 的端口」这类运行期才发现的问题。 */
export type PortType =
  | 'any' // 通配：与任何类型兼容（兜底，默认）
  | 'text' // 文本 / 标量（与 number、boolean 互通，运行时模板会处理）
  | 'number'
  | 'boolean'
  | 'list' // 列表：仅与 list 兼容
  | 'json' // 结构化对象：仅与 json 兼容
  | 'image'; // 图片（data URL 或 https 链接），用于多模态图生文

export interface PortDef {
  id: string;
  label: string;
  /** 端口数据类型，缺省视为 'any'（兼容所有，向后兼容旧节点） */
  type?: PortType;
  /** 端口连线语义：
   * - 'data'：值传递（默认，现有语义）
   * - 'task'：任务派发（控制流，带 scope，用于 Dispatcher → 下游并行施工）
   * - 'control'：条件/循环断点（控制流，拓扑排序时视作 stage 边界）
   * 缺省视为 'data'，向后兼容旧节点。 */
  flow?: EdgeKind;
}

/* ---------- 连线语义分层（data / task / control） ---------- */
/** 连线种类：
 * - 'data'：数据流（值传递，现有默认）
 * - 'task'：任务流（派发任务，控制流，带 scope）
 * - 'control'：控制流（条件/循环断点，拓扑排序视作断点） */
export type EdgeKind = 'data' | 'task' | 'control';

/** 连线展示样式：按 kind 区分颜色与线型 */
export const EDGE_KIND_STYLE: Record<EdgeKind, { color: string; dash?: string; label: string }> = {
  data: { color: '#9ca3af', label: '数据' },
  task: { color: '#f59e0b', dash: '6 3', label: '任务' },
  control: { color: '#8b5cf6', dash: '2 4', label: '控制' },
};

/** 画布连线的 data 载荷 */
export interface FlowEdgeData extends Record<string, unknown> {
  kind?: EdgeKind;
  /** task 流的派发影响域声明（affected files / symbols），供 Coordinator 冲突检测 */
  scope?: string[];
}

/**
 * 连线兼容性：返回 source 端口输出能否连到 target 端口输入。
 * 规则：
 *  - 任一为 'any' -> 兼容（通配兜底）
 *  - 类型相同 -> 兼容
 *  - text / number / boolean 三者互通（标量，运行时表达式与模板可处理）
 *  - list 仅兼容 list；json 仅兼容 json
 */
export function arePortsCompatible(src?: PortType, tgt?: PortType): boolean {
  const s: PortType = src ?? 'any';
  const t: PortType = tgt ?? 'any';
  if (s === 'any' || t === 'any') return true;
  if (s === t) return true;
  const scalar = new Set<PortType>(['text', 'number', 'boolean']);
  return scalar.has(s) && scalar.has(t);
}

export type ParamType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'agent'
  | 'role'
  | 'asset'; // 从当前工作流资产库选择（图片资产下拉 + 气泡手填路径）

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: { label: string; value: string }[];
  default?: unknown;
  placeholder?: string;
}

export interface ExecLogger {
  info(message: string): void;
  error(message: string): void;
}

/* ---------- 成本遥测（Auditor / 自优化闭环） ---------- */
/** 单次 LLM 调用的 token 用量（与 OpenAI/Anthropic 对齐，缺字段为 undefined） */
export interface TokenUsage {
  promptTokens?: number;
  /** 命中 prompt cache 的 tokens（缓存读取） */
  cachedPromptTokens?: number;
  /** 新写入 prompt cache 的 tokens（缓存写入） */
  writtenPromptTokens?: number;
  completionTokens?: number;
  /** 推理/思考过程消耗的 tokens（如 o1 reasoning_tokens） */
  reasoningTokens?: number;
  /** 回复正文消耗的 tokens（completion 的子集，若 provider 未区分则与 completionTokens 相同） */
  replyTokens?: number;
  totalTokens?: number;
}

/** 一次 LLM 调用的统一返回（文本 + 可选用量） */
export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
}

/** 一条成本记录：可供 Coordinator/Stenographer/Auditor 复用 */
export interface CostRecord {
  /** 产生该记录的节点 id（engine 填充） */
  nodeId: string;
  nodeLabel: string;
  /** 实际使用的智能体 id 与模型（含 modelOverride） */
  agentId: string;
  model: string;
  /** token 用量（provider 未返回则为 undefined） */
  usage?: TokenUsage;
  /** 本次调用耗时（毫秒） */
  durationMs: number;
  /** 发生时间戳（ISO） */
  at: string;
  /** 调用是否失败 */
  ok: boolean;
  /** 是否命中节点缓存（true=未实际调用 LLM，复用缓存结果） */
  cached?: boolean;
  /** 失败原因（ok=false 时） */
  error?: string;
}

/** 成本账本：运行期累积数组 */
export type CostLedger = CostRecord[];

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

export interface ExecContext {
  logger: ExecLogger;
  /** 通过智能体 id 调用 LLM，多协议路由由内部完成。
   * 传入 onToken 回调即启用流式输出（逐 token 回传）。
   * modelOverride 可用于节点级模型覆写（仅本次调用生效）。 */
  llm(
    agentId: string,
    messages: ChatMessage[],
    onToken?: (text: string) => void,
    modelOverride?: string,
  ): Promise<string>;
  /** 成本遥测：每次 LLM 调用后由引擎回调，记录 token 用量与耗时。
   * Auditor 节点借此汇总全链路成本。 */
  reportCost(record: CostRecord): void;
  /** 本次运行全程的成本账本（累积数组），Auditor 节点读取生成报告 */
  costLog: CostRecord[];
  /** 执行中实时回写当前节点的某输出端口，用于流式预览 */
  setPartial(key: string, value: unknown): void;
  /** 分支节点在执行时声明「激活的输出端口 handle 集合」，未列出的下游分支将被跳过 */
  setBranches?(handles: string[]): void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  signal: AbortSignal;
  /** 全局变量（可在 {{}} 模板与表达式中引用） */
  vars: Record<string, unknown>;
  /** 当前工作流的资产库（图片资产直连用），含 id/name/kind/content 等 */
  assets: AssetMeta[];
  /** 向当前工作流追加一条资产记录（图片保存节点用） */
  addAsset(meta: AssetMeta): void;
}

export type NodeExecuteFn = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: ExecContext,
) => Promise<Record<string, unknown>>;

export interface NodeDefinition {
  typeId: string;
  name: string;
  category: string;
  description?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  execute: NodeExecuteFn;
  /** 来源插件 id（内置节点为空） */
  pluginId?: string;
  /** 导入工作流时未找到类型的占位标记 */
  missing?: boolean;
}

/* ---------- 画布数据 ---------- */
export interface WorkflowNodeData extends Record<string, unknown> {
  typeId: string;
  label: string;
  params: Record<string, unknown>;
  status: NodeStatus;
  error?: string;
  outputs?: Record<string, unknown>;
  /** 增量执行标记：true 表示该节点被修改/受影响，需重新执行；false 或缺失表示可命中缓存 */
  dirty?: boolean;
  /** 最近一次执行耗时（毫秒）；缓存命中/跳过为 null。仅用于画布展示 */
  durationMs?: number | null;
  /** 最近一次真正执行的开始时间戳（ISO）；缓存命中/跳过为 null */
  startedAt?: string | null;
  /** 最近一次运行中该节点自身的 token 用量；无 LLM 调用时缺失 */
  usage?: NodeUsageStat;
}

export type FlowNode = Node<WorkflowNodeData>;

/** 单个节点在最近一次运行中的 token 用量聚合（画布悬停浮层展示用） */
export interface NodeUsageStat {
  /** 该节点累计发生的 LLM 调用次数 */
  calls: number;
  /** 其中失败的调用次数 */
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  writtenPromptTokens: number;
  reasoningTokens: number;
  replyTokens: number;
  /** 累计 LLM 调用耗时（毫秒），不含节点自身其他开销 */
  llmDurationMs: number;
  /** 参与过的模型名（去重，按首次出现顺序） */
  models: string[];
}
export type FlowEdge = Edge<FlowEdgeData>;

/* ---------- 工作流文件 ---------- */
export interface WorkflowFileNode {
  id: string;
  typeId: string;
  label: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface WorkflowFileEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  /** 连线语义（data/task/control），缺省 'data'，向后兼容旧工作流文件 */
  kind?: EdgeKind;
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
  /** 人类可读的配置/使用说明（示例文件常见；运行时忽略，仅供阅读与导入后展示） */
  notes?: string;
  /** 运行历史（P2 成本跟项目：落盘到 .slimemold/runs/history.json） */
  runs?: { history: RunRecord[] };
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

/** 资产（写文件节点产出的文件/预览）元数据 */
export interface AssetMeta {
  id: string;
  /** 显示名（通常带扩展名），如 hello_world.py */
  name: string;
  /** 落盘的绝对路径；若为 null 表示仅存入工作流内部、随工作流销毁（未真正写盘） */
  path: string | null;
  /** 文件类型提示，如 'python' / 'text' / 'image' / 'json' */
  kind: string;
  /** 文本内容（用于预览与导出；二进制资产可为空） */
  content: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 产出该资产的节点 id */
  nodeId?: string;
  /** 是否为工作区文件（true=落到用户指定文件夹；false=工作流内部临时目录） */
  inWorkspace: boolean;
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
}

/** 最近项目记录（持久化在 localStorage，不随项目文件本身） */
export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

/* ---------- 运行历史 ---------- */
export interface RunNodeResult {
  id: string;
  label: string;
  typeId: string;
  status: NodeStatus;
  outputs: Record<string, unknown> | null;
  error: string | null;
  /** 节点开始执行的时间戳（ISO），缓存/跳过节点为 null（未真正执行） */
  startedAt: string | null;
  /** 节点实际执行耗时（毫秒）；缓存命中/跳过/上游失败为 null */
  durationMs: number | null;
  /** 该节点产生的成本记录（仅 LLM 节点有；非 LLM 或缓存命中为 null） */
  cost?: CostRecord[] | null;
}

export interface RunRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'success' | 'error' | 'aborted';
  nodeCount: number;
  nodes: RunNodeResult[];
  /** 成本聚合：全链路 token 用量与耗时（成本可观测性 / 自优化闭环） */
  cost?: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalDurationMs: number;
    /** 缓存统计（命中/未命中/写入的 tokens；按 prompt tokens 口径） */
    cache: {
      hitTokens: number;
      missTokens: number;
      writeTokens: number;
    };
    /** 输出细分：推理过程 vs 回复内容 */
    output: {
      reasoningTokens: number;
      replyTokens: number;
    };
    /** 按模型归类的用量，便于「性价比」分析 */
    byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }>;
    records: CostRecord[];
  } | null;
  /** 摘要说明与成败标记（StatusBar 运行历史行使用） */
  note?: string;
  ok?: boolean;
}

/* ---------- 插件 ---------- */
export interface PluginNodeMeta {
  typeId: string;
  name: string;
  category?: string;
  description?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params?: ParamDef[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** 入口脚本文件名，如 index.js */
  entry: string;
  nodes: PluginNodeMeta[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  source: 'dir' | 'files';
  path?: string;
}

/* ---------- 日志 ---------- */
export interface LogEntry {
  time: string;
  level: 'info' | 'error';
  message: string;
  /** 可选：单次运行的摘要说明与成败标记（运行历史行使用） */
  note?: string;
  ok?: boolean;
}
