import type { CapabilityLevel } from './capability';
import type { ChatMessage, CostRecord, ExecLogger } from './agent';
import type { AssetMeta } from './project';
import type { ParamDef, PortDef } from './graph';

export interface ExecContext {
  logger: ExecLogger;
  /** 通过智能体 id 调用 LLM，多协议路由由内部完成。 */
  llm(
    agentId: string,
    messages: ChatMessage[],
    onToken?: (text: string) => void,
    modelOverride?: string,
    toolNames?: string[],
  ): Promise<string>;
  /** 成本遥测：每次 LLM 调用后由引擎回调。 */
  reportCost(record: CostRecord): void;
  /** 本次运行全程的成本账本。 */
  costLog: CostRecord[];
  /** 执行中实时回写当前节点的某输出端口。 */
  setPartial(key: string, value: unknown): void;
  /** 分支节点声明激活的输出端口。 */
  setBranches?(handles: string[]): void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  signal: AbortSignal;
  vars: Record<string, unknown>;
  assets: AssetMeta[];
  addAsset(meta: AssetMeta): void;
  writeOutEdgeScope?(handle: string, scope: string[]): void;
  sandbox?: SandboxHandle;
  sandboxLanes?: string[];
  intervene?(request: InterventionRequest): Promise<InterventionResult>;
  nodeId?: string;
}

/** 实时接管请求。 */
export interface InterventionRequest {
  message: string;
  defaultResult?: string;
}

/** 实时接管结果。 */
export type InterventionResult =
  | { kind: 'resolved'; result: string }
  | { kind: 'cancelled'; error?: string };

/**
 * 沙箱句柄：把并行改同一份文件的竞态收敛为各自改副本、协调者合并。
 */
export interface SandboxHandle {
  nodeId: string;
  baseDir: string | null;
  inBrowser: boolean;
  writeFile(filename: string, content: string): Promise<string>;
  readFrom(otherNodeId: string, filename: string): Promise<string | null>;
  list(otherNodeId: string): Promise<string[]>;
  commitAll(): Promise<string[]>;
  commitLanes(laneIds: string[]): Promise<string[]>;
}

export type NodeExecuteFn = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: ExecContext,
) => Promise<Record<string, unknown>>;

/** 节点角色分类。 */
export type NodeRole =
  | 'orchestrator'
  | 'architect'
  | 'explorer'
  | 'worker'
  | 'verifier'
  | 'observer'
  | 'io';

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

export interface NodeDefinition {
  typeId: string;
  name: string;
  category: string;
  description?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  execute: NodeExecuteFn;
  pluginId?: string;
  missing?: boolean;
  role?: NodeRole;
  whenToUse?: string;
  minCapability?: CapabilityLevel;
}

export type NodeDefInput = {
  typeId: string;
  name: string;
  inputs: PortDef[];
  outputs: PortDef[];
  execute: NodeExecuteFn;
} & Partial<Omit<NodeDefinition, 'typeId' | 'name' | 'inputs' | 'outputs' | 'execute'>>;

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
    for (const port of def.inputs) {
      if (inIds.has(port.id)) console.warn(`[createNodeDef] 节点 ${def.typeId} 输入端口 id 重复: ${port.id}`);
      inIds.add(port.id);
    }
    const outIds = new Set<string>();
    for (const port of def.outputs) {
      if (outIds.has(port.id)) console.warn(`[createNodeDef] 节点 ${def.typeId} 输出端口 id 重复: ${port.id}`);
      outIds.add(port.id);
    }
  }
  return def;
}

function inferRole(typeId: string): NodeRole {
  if (typeId.startsWith('coord.') || typeId.startsWith('dispatch.') || typeId.startsWith('flow.')) {
    return 'orchestrator';
  }
  if (typeId.startsWith('architect.')) return 'architect';
  if (typeId.startsWith('agent.') || typeId.startsWith('tool.') || typeId.startsWith('http')) return 'worker';
  if (typeId.startsWith('verify.') || typeId.startsWith('auditor.')) return 'verifier';
  if (typeId.startsWith('output.') || typeId.startsWith('image.preview')) return 'observer';
  if (typeId.startsWith('input.')) return 'io';
  return 'worker';
}
