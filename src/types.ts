import type { Node, Edge } from '@xyflow/react';

/* ---------- 节点状态与协议 ---------- */
export type NodeStatus = 'idle' | 'running' | 'success' | 'error';
export type Protocol = 'openai' | 'anthropic' | 'ollama';

/* ---------- 智能体配置 ---------- */
export interface AgentConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /** 绑定的角色（角色库 id）。节点可通过角色快速获得预设提示词与默认模型，可被节点级覆写 */
  roleId?: string;
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/* ---------- 节点定义 ---------- */
export interface PortDef {
  id: string;
  label: string;
}

export type ParamType = 'text' | 'textarea' | 'number' | 'select' | 'agent' | 'role';

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
  /** 执行中实时回写当前节点的某输出端口，用于流式预览 */
  setPartial(key: string, value: unknown): void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  signal: AbortSignal;
  /** 全局变量（可在 {{}} 模板与表达式中引用） */
  vars: Record<string, unknown>;
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
}

export type FlowNode = Node<WorkflowNodeData>;
export type FlowEdge = Edge;

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
}

/* ---------- 运行历史 ---------- */
export interface RunNodeResult {
  id: string;
  label: string;
  typeId: string;
  status: NodeStatus;
  outputs: Record<string, unknown> | null;
  error: string | null;
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
}
