import type { Edge, Node } from '@xyflow/react';

/** Runtime status carried by a workflow node. */
export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'cached' | 'skipped' | 'bypassed' | 'muted';

/** Port data types used by graph connection validation. */
export type PortType =
  | 'any'
  | 'text'
  | 'number'
  | 'boolean'
  | 'list'
  | 'json'
  | 'image';

export type EdgeKind = 'data' | 'task' | 'control';

export const EDGE_KIND_STYLE: Record<EdgeKind, { color: string; dash?: string; label: string }> = {
  data: { color: '#9ca3af', label: '数据' },
  task: { color: '#f59e0b', dash: '6 3', label: '任务' },
  control: { color: '#8b5cf6', dash: '2 4', label: '控制' },
};

export interface PortDef {
  id: string;
  label: string;
  type?: PortType;
  flow?: EdgeKind;
}

export interface FlowEdgeData extends Record<string, unknown> {
  kind?: EdgeKind;
  scope?: string[];
}

export function arePortsCompatible(src?: PortType, tgt?: PortType): boolean {
  const source: PortType = src ?? 'any';
  const target: PortType = tgt ?? 'any';
  if (source === 'any' || target === 'any') return true;
  if (source === target) return true;
  const scalar = new Set<PortType>(['text', 'number', 'boolean']);
  return scalar.has(source) && scalar.has(target);
}

export type ParamType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'agent'
  | 'agents'
  | 'role'
  | 'asset';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: { label: string; value: string }[];
  default?: unknown;
  placeholder?: string;
  tooltip?: string;
}

export interface WorkflowNodeData extends Record<string, unknown> {
  typeId: string;
  label: string;
  params: Record<string, unknown>;
  status: NodeStatus;
  error?: string;
  outputs?: Record<string, unknown>;
  dirty?: boolean;
  durationMs?: number | null;
  startedAt?: string | null;
  usage?: NodeUsageStat;
  bypass?: boolean;
  mute?: boolean;
}

export type FlowNode = Node<WorkflowNodeData>;

export interface NodeUsageStat {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  writtenPromptTokens: number;
  reasoningTokens: number;
  replyTokens: number;
  llmDurationMs: number;
  models: string[];
}

export type FlowEdge = Edge<FlowEdgeData>;
