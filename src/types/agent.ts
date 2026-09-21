/**
 * Agent-facing contracts: provider configuration, roles, messages, tool wire format,
 * and cost telemetry. This module is type-only and has no store/runtime dependencies.
 */
/* ---------- 节点状态与协议 ---------- */
export type AntigravityMode = 'ask' | 'edit' | 'agent' | 'custom';
export type Protocol = 'openai' | 'anthropic' | 'ollama' | 'codex' | 'antigravity';

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
  /** 明文 apiKey：仅在 headless / 本地 Ollama / 受控测试场景下使用。
   *  桌面 API provider 应通过 credentialKey 从系统密钥库取，Codex provider 不需要此字段。 */
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
  /** Antigravity CLI 专属 workspace 运行配置；不代表 Gemini API 模型/计费配置。 */
  runtimeMode?: AntigravityMode;
  runtimeProfile?: string;
  runtimeCliPath?: string;
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
