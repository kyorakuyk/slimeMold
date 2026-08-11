import type { Node, Edge } from '@xyflow/react';

/* ---------- 节点状态与协议 ---------- */
export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'cached' | 'skipped' | 'bypassed' | 'muted';
export type Protocol = 'openai' | 'anthropic' | 'ollama';

/* ---------- API 接入点（APIKEYS 分区集中管理的「网址 + 密钥」） ---------- */
/** 一个 API 接入点：把 Base URL 与密钥绑定成可复用的配置单元（类似 cc-switch 的 API 路由）。
 * - name：唯一标识，也作为系统密钥库的条目键（实际存 `ep::<name>`）。
 * - 密钥明文仅存系统密钥库；此结构不持久化明文（运行时从密钥库取回）。
 * @deprecated 2026-08-09 起由 ApiVault 取代（一次性迁移），保留仅用于读旧数据兼容。 */
export interface ApiEndpoint {
  name: string;
  protocol: Protocol;
  /** 中转站 / 官方 Base URL，如 https://apinebula.ai/v1 */
  baseUrl: string;
  /** 系统密钥库中的凭据键（= name）。智能体可经此键引用，无需重复填 key。 */
  credentialKey: string;
}

/* ---------- Vault（自动分组密钥库，2026-08-09） ---------- */
/** 厂商分组（录入时按 baseUrl 域名自动推断，不靠用户打标）。 */
export type Vendor = 'deepseek' | 'openai' | 'anthropic' | 'claude' | 'siliconflow' | 'openrouter' | 'transit';

/** 一个 Vault：一次录入一个明文 Key，id 自动生成、vendor 自动分组、可挂多个模型。
 * 密钥明文只存 Rust 加密存储，此结构不含明文 apiKey。 */
export interface ApiVault {
  /** 自动生成的唯一 id（UUID），也是存储键 */
  id: string;
  /** 展示名（录入时可自动取 baseUrl 域名，用户可改） */
  label: string;
  /** 自动推断的厂商分组 */
  vendor: Vendor;
  protocol: Protocol;
  /** 中转站 / 官方 Base URL，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** 该 key 可用的模型列表（经 /models 拉取；可选） */
  models?: string[];
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
  /** 是否启用：false 表示被禁用，不出现在可选用 agent 候选中（节点/路由表），但保留在智能体库列表中可重新启用。缺省视为启用 */
  enabled?: boolean;
  /** 经济参数（G3 成本感知路由）：用户可覆盖内置价格表。订阅制模型置 subscription=true 按 0 计价 */
  cost?: {
    /** 每 1M token 输入价（USD），覆盖内置价格表 */
    inputPrice?: number;
    /** 每 1M token 输出价（USD），覆盖内置价格表 */
    outputPrice?: number;
    /** 固定成本（USD/调用），如订阅模型按调用平摊 */
    fixedCost?: number;
  };
  /** 订阅制模型：true 表示无按 token 计费（走订阅额度），成本评分按 0 计价 */
  subscription?: boolean;
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
  | { type: 'image'; url: string; mediaType?: string }
  /** 助手消息中的工具调用片段（OpenAI 格式：assistant 消息携带） */
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; id?: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 文本消息为 string；多模态（图生文）消息为内容片段数组 */
  content: string | ContentPart[];
  /** role='tool' 时必填：对应的 tool_call id（OpenAI 协议回写工具结果用） */
  tool_call_id?: string;
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
  | 'boolean'
  | 'select'
  | 'agent'
  | 'agents' // 多选智能体（逗号分隔的 agentId 列表）
  | 'role'
  | 'asset'; // 从当前工作流资产库选择（图片资产下拉 + 气泡手填路径）

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: { label: string; value: string }[];
  default?: unknown;
  placeholder?: string;
  /** 面板/Inspector 中的使用提示（悬停 tooltip） */
  tooltip?: string;
}

export interface ExecLogger {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
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
/** 工具调用（由 provider 回传，harness 据此驱动多轮 tool_call 循环） */
export interface ToolCall {
  /** 工具名（与 ToolRegistry 中注册名一致） */
  name: string;
  /** 调用参数（已解析为对象；provider 层负责把模型给出的 JSON string 解析好） */
  args: Record<string, unknown>;
  /** 模型原样给出的调用 id（用于回写 tool 结果消息的 tool_call_id） */
  id?: string;
}

export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
  /** 模型请求的工具调用；非空时 harness 进入 tool 执行轮次，否则结束 loop */
  toolCalls?: ToolCall[];
}

/** 传给 provider 的工具规格（JSON schema 风格），由 ToolRegistry 提供 */
export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema 对象，描述参数 */
  parameters: Record<string, unknown>;
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

export interface ExecContext {
  logger: ExecLogger;
  /** 通过智能体 id 调用 LLM，多协议路由由内部完成。
   * 传入 onToken 回调即启用流式输出（逐 token 回传）。
   * modelOverride 可用于节点级模型覆写（仅本次调用生效）。
   * toolNames 传入则由底层 AgentHarness 启用 tool_call 多轮循环（按名引用 ToolRegistry）。 */
  llm(
    agentId: string,
    messages: ChatMessage[],
    onToken?: (text: string) => void,
    modelOverride?: string,
    toolNames?: string[],
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
  /** 执行时把当前节点某输出端口的影响域(scope)写回对应的 task 连线，
   * 供下游「冲突协调者」与执行引擎读取。仅对 flow:'task' 端口有意义，未提供则不写回。 */
  writeOutEdgeScope?(handle: string, scope: string[]): void;
  /**
   * 真沙箱句柄（步骤 11 阶段 C）：运行期启用 `sandbox: true` 时注入。
   * 每个写文件的节点拿到独立隔离目录（workspaceDir/.sandbox/<nodeId>/），并行 Worker
   * 互不踩踏；协调者（coord.resolver / coord.council）拿到聚合句柄，可读取各 Worker
   * 沙箱并 commitAll() 汇总进主工作区。未启用沙箱时为 undefined，节点应退回共享工作区直写。
   */
  sandbox?: SandboxHandle;
  /**
   * 协调者（coord.resolver / coord.council）在沙箱模式下的「上游车道」节点 id 列表，
   * 即直接连入本节点的源节点。供 commitLanes 汇总这些 Worker 的沙箱产物到主工作区。
   */
  sandboxLanes?: string[];
  /**
   * 实时接管（阶段 D）：节点可请求人工介入——挂起本节点执行，直到用户在 UI
   * 提交结果（resolved）或取消（cancelled）。仅显式调用此能力的节点生效；
   * 默认不注入此能力时节点正常自动执行，行为完全不变。
   */
  intervene?(request: InterventionRequest): Promise<InterventionResult>;
  /**
   * 当前节点 id（owner ?? id，子图虚拟节点回写用）。供沙箱插件 RPC 按节点归属路由
   * 日志/partial/能力调用；非沙箱节点通常不需要读它。
   */
  nodeId?: string;
}

/** 实时接管请求（阶段 D）：节点请求人工介入的输入。 */
export interface InterventionRequest {
  /** 请求说明（为何需要人工介入），展示给用户 */
  message: string;
  /** 可选的预填结果（如模型中途产出的草稿），用户可修改后提交 */
  defaultResult?: string;
}

/** 实时接管结果（阶段 D）：人工介入的两种结束方式。 */
export type InterventionResult =
  | { kind: 'resolved'; result: string }
  | { kind: 'cancelled'; error?: string };

/**
 * 沙箱句柄：把"并行改同一份文件"的竞态收敛为"各自改副本、协调者合并"。
 * - 普通 Worker 节点：用 writeFile 落到自己的隔离目录；
 * - 协调者节点：用 readFrom / list 汇聚各 Worker 产物，commitAll 把结果落地主工作区。
 * 浏览器环境无真实文件系统，baseDir 为 null，所有读写为内存态（仅登记资产预览）。
 */
export interface SandboxHandle {
  /** 当前节点 id */
  nodeId: string;
  /** 沙箱根目录绝对路径；浏览器为 null */
  baseDir: string | null;
  /** 是否浏览器环境（无真实文件系统） */
  inBrowser: boolean;
  /** 在「当前节点」的沙箱内写文件，返回沙箱内路径（Tauri）或标识串（浏览器） */
  writeFile(filename: string, content: string): Promise<string>;
  /** 读取「另一节点」沙箱内的文件内容（协调者汇总用）；不存在返回 null */
  readFrom(otherNodeId: string, filename: string): Promise<string | null>;
  /** 列出「另一节点」沙箱内的文件名列表（协调者汇总用） */
  list(otherNodeId: string): Promise<string[]>;
  /** 把「当前节点沙箱」的全部内容提交（复制）到主工作区目录；返回已落盘的路径列表 */
  commitAll(): Promise<string[]>;
  /**
   * 协调者专用：把若干「上游车道（worker 节点）」的沙箱内容汇总提交到主工作区。
   * 用于并行 Worker 各自写沙箱副本后，由 coord.resolver / coord.council 统一落地。
   * laneIds 通常为协调者节点的直接上游节点 id 列表。
   */
  commitLanes(laneIds: string[]): Promise<string[]>;
}

export type NodeExecuteFn = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: ExecContext,
) => Promise<Record<string, unknown>>;

/** 节点角色分类（对齐多 Agent 编排语义：编排者 / 探索者 / 执行者 / 校验者 / 观察者 / 输出）。
 * 用于节点面板按角色筛选与场景推荐，帮助用户快速定位「这一步该用哪类节点」。 */
export type NodeRole =
  | 'orchestrator' // 编排 / 调度 / 控制流（flow.*、dispatch.*、coord.*）
  | 'architect' // 架构设计 / 技术规划（architect.*）
  | 'explorer' // 探索 / 取数 / 检索（tool.http、image.load）
  | 'worker' // 执行者 / 生产内容（agent.chat、image.generate、tool.writeFile）
  | 'verifier' // 校验 / 断言 / 审计（verify.assert、auditor.*）
  | 'observer' // 观察 / 汇总 / 预览（output.*、image.preview）
  | 'io'; // 输入 / 输出端点（input.*、output.text 等）

export const NODE_ROLE_META: Record<
  NodeRole,
  { label: string; color: string; hint: string }
> = {
  orchestrator: { label: '编排', color: '#8b5cf6', hint: '调度流程、控制分支与循环' },
  architect: { label: '架构', color: '#6366f1', hint: '技术设计、模块划分与接口规划' },
  explorer: { label: '探索', color: '#0ea5e9', hint: '抓取外部数据、检索与读取' },
  worker: { label: '执行', color: '#2e9e5b', hint: '调用 LLM / 生成内容 / 落盘' },
  verifier: { label: '校验', color: '#f59e0b', hint: '质量闸门、断言与成本审计' },
  observer: { label: '观察', color: '#64748b', hint: '汇总结果、预览与展示' },
  io: { label: '端点', color: '#9ca3af', hint: '工作流的输入与输出边界' },
};

/**
 * 步骤 11 阶段 D：节点权限能力分级（capability model）。
 * 执行引擎在 executeNode 时按节点声明的 minCapability（或按 typeId 推断的默认等级）
 * 裁剪注入的 ExecContext：越权字段被替换为「拒绝型」实现，而非缺失（保持类型完整、运行时受控）。
 *
 * - `compute`       L0 纯计算只读：仅 logger/vars/signal/costLog。禁止任何 I/O（无 llm/storage/sandbox/addAsset）。
 * - `io`            L1 受限 I/O：+ storage/addAsset/llm/assets。不直接碰工作区文件系统。
 * - `sandbox_write` L2 隔离写：+ sandbox 句柄，但剥离 commitAll/commitLanes（落地权只给协调者）。
 * - `coordinator`   L3 协调者：+ sandboxLanes + 完整 commit 汇总权（唯一能把沙箱产物落地主工作区的角色）。
 * - `system`        L4 系统级：可经 Rust command 调用系统能力（git worktree 等）。当前前端节点自主 invoke，引擎仅放开签名。
 *
 * 等级单调递增：未显式声明 minCapability 时，引擎按 typeId 前缀推断默认等级（见 executor.resolveCapability）。
 */
export type CapabilityLevel = 'compute' | 'io' | 'sandbox_write' | 'coordinator' | 'system';

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
  /** 节点角色分类（用于面板筛选与场景推荐） */
  role?: NodeRole;
  /** 使用建议：何时该用这个节点（显示在面板 tooltip / 角色筛选说明） */
  whenToUse?: string;
  /**
   * 步骤 11 阶段 D：节点权限能力等级下限。执行引擎据此裁剪注入的 ExecContext。
   * 未声明时按 typeId 前缀推断默认等级（见 executor.resolveCapability）。
   * 显式声明可用于收紧（如把内置写文件节点降为 io 以禁止落盘）或放开（插件节点声明 coordinator）。
   */
  minCapability?: CapabilityLevel;
}

/** 自定义节点的宽松入参：必填最小集合，其余字段由 createNodeDef 兜底。 */
export type NodeDefInput = {
  typeId: string;
  name: string;
  inputs: PortDef[];
  outputs: PortDef[];
  execute: NodeExecuteFn;
} & Partial<Omit<NodeDefinition, 'typeId' | 'name' | 'inputs' | 'outputs' | 'execute'>>;

/**
 * 步骤 11 阶段 D：自定义节点工厂。降低手写 NodeDefinition 的门槛——
 * 补齐缺省字段（category 默认「自定义」、params 默认 []、role 按 typeId 前缀推断），
 * 并在开发期（DEV）做端口 id 唯一性等轻量校验（warn 不抛错，不打断运行）。
 *
 * - minCapability 缺省不在此处理：交给引擎 resolveCapability 的权威推断（单一真相源）；
 *   显式传入则透传采用（同文件 NodeDefinition.minCapability 注释）。
 * - role 缺省按 typeId 前缀推断（coord./dispatch./flow.→orchestrator，architect.→architect，
 *   agent./tool./http→worker，verify./auditor.→verifier，output./image.preview→observer，input.→io，其余→worker）。
 */
export function createNodeDef(input: NodeDefInput): NodeDefinition {
  const role = input.role ?? inferRole(input.typeId);
  const def: NodeDefinition = {
    typeId: input.typeId,
    name: input.name,
    category: input.category ?? '自定义',
    description: input.description,
    inputs: input.inputs,
    outputs: input.outputs,
    params: input.params ?? [],
    execute: input.execute,
    pluginId: input.pluginId,
    missing: input.missing,
    role,
    whenToUse: input.whenToUse,
    minCapability: input.minCapability,
  };

  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const inIds = new Set<string>();
    for (const p of def.inputs) {
      if (inIds.has(p.id)) console.warn(`[createNodeDef] 节点 ${def.typeId} 输入端口 id 重复: ${p.id}`);
      inIds.add(p.id);
    }
    const outIds = new Set<string>();
    for (const p of def.outputs) {
      if (outIds.has(p.id)) console.warn(`[createNodeDef] 节点 ${def.typeId} 输出端口 id 重复: ${p.id}`);
      outIds.add(p.id);
    }
  }
  return def;
}

function inferRole(typeId: string): NodeRole {
  if (typeId.startsWith('coord.') || typeId.startsWith('dispatch.') || typeId.startsWith('flow.'))
    return 'orchestrator';
  if (typeId.startsWith('architect.')) return 'architect';
  if (typeId.startsWith('agent.') || typeId.startsWith('tool.') || typeId.startsWith('http'))
    return 'worker';
  if (typeId.startsWith('verify.') || typeId.startsWith('auditor.')) return 'verifier';
  if (typeId.startsWith('output.') || typeId.startsWith('image.preview')) return 'observer';
  if (typeId.startsWith('input.')) return 'io';
  return 'worker';
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
  /** 调试开关：bypass=跳过执行、同名端口透传输入到输出；mute=完全屏蔽（不执行、输出为空） */
  bypass?: boolean;
  mute?: boolean;
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
  /** 项目级运行历史（持久化） */
  runs?: { history: RunRecord[] };
  /** 运行检查点（阶段 C 可恢复执行）：按 wfId 覆盖式存储最近一次运行的节点级结果，随项目落盘 */
  checkpoints?: Record<string, import('./engine/checkpoint').RunCheckpoint>;
  /** 检查点多版本历史（阶段 G2）：按 wfId 保留最近 N 条运行快照 */
  checkpointHistory?: Record<string, import('./engine/checkpoint').RunCheckpoint[]>;
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
/**
 * 步骤 13（人类-职业-个人抽象）· 自定义职业声明。
 * 允许 custom node 包定义「一类节点」（新职业），而非只能定义单个具体节点。
 * 职业类须继承某个框架职业（见 src/nodes/sdk.ts 的 OCCUPATION_CAPABILITY），
 * 其下具体节点通过 PluginNodeMeta.extends 指向该职业类名，从而获得对应能力等级。
 */
export interface PluginOccupation {
  /** 职业类名（在 index.js 中 export，节点 extends 引用此名） */
  name: string;
  /** 继承的框架职业类名（ComputeNode/IoNode/SandboxWriteNode/CoordinatorNode/SystemNode/GitNode） */
  extends: string;
  description?: string;
}

export interface PluginNodeMeta {
  typeId: string;
  name: string;
  category?: string;
  description?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params?: ParamDef[];
  /** 插件节点显式声明的最小能力等级；省略时 loader 默认按 'io' 受限边界注入。 */
  minCapability?: CapabilityLevel;
  /**
   * 步骤 13：声明该节点继承的「职业类」名（框架职业或本包 occupations 中定义的新职业）。
   * 这是继承式提权的唯一入口——不写 extends 的纯 executors 函数节点永远封顶 io。
   * loader 据此把职业类名翻译成 CapabilityLevel（见 sdk.capabilityOfClass），
   * 因此写代码时 `class extends SandboxWriteNode` 与 manifest 里 `extends: "SandboxWriteNode"`
   * 必须一致（DEV 下校验）。
   */
  extends?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** 入口脚本文件名，如 index.js */
  entry: string;
  nodes: PluginNodeMeta[];
  /**
   * 步骤 13 阶段 E：本包自定义的职业类清单（创造「新职业」）。
   * 节点 extends 可指向其中 name；loader 沿「自定义职业 → 其 extends 的框架职业」解析最终能力。
   */
  occupations?: PluginOccupation[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  // 'dir' = AppData 正式插件；'files' = 浏览器/手动导入；'custom' = custom_nodes/ 用户节点（能力封顶 io）
  source: 'dir' | 'files' | 'custom';
  path?: string;
  // custom 来源的生效范围：'program' = 程序安装目录（全局生效，跨项目）；'project' = 当前项目目录（仅本项目内生效）
  scope?: 'program' | 'project';
}

/* ---------- 日志 ---------- */
export interface LogEntry {
  time: string;
  level: 'info' | 'error' | 'warn';
  message: string;
  /** 可选：单次运行的摘要说明与成败标记（运行历史行使用） */
  note?: string;
  ok?: boolean;
}

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
  /** 关联运行 id（runEvents 重放；executor runId 数字代次） */
  runIds: (string | number)[];
}
