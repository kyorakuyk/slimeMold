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

export type ParamType = 'text' | 'textarea' | 'number' | 'select' | 'agent';

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
   * 传入 onToken 回调即启用流式输出（逐 token 回传）。 */
  llm(
    agentId: string,
    messages: ChatMessage[],
    onToken?: (text: string) => void,
  ): Promise<string>;
  /** 执行中实时回写当前节点的某输出端口，用于流式预览 */
  setPartial(key: string, value: unknown): void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  signal: AbortSignal;
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
