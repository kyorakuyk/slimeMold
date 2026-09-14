/**
 * nodeExecutionPolicy.ts — 节点执行前置决策（executor 拆分，Codex 建议第一刀）。
 *
 * 把 executeNode 开头的「前置决策」集中为纯函数 decideNodeExecution：
 * - 输入：resolveNodeExecutionMode 结果（upstream-failed / missing-def / bypass / mute /
 *   incremental-skip / execute）+ 分支剪枝 / stopAfter 裁剪 / 缓存命中所需上下文
 * - 输出：统一 NodeDecision 联合类型，**不直接改 store**
 * - 副作用（setStatus / emitNode / outputsMap / branchState / countSkip）由调用方执行
 *
 * 缓存键计算所需函数（collectInputs / cacheKey / getCached）作为参数注入，保持零 store 依赖。
 * isBranchPruned 本地实现（与 graphAlgo 一致），避免本模块反向依赖 graphAlgo。
 */
import type { FlowEdge, FlowNode, NodeStatus } from '../types';
import type { NodeExecutionMode } from './graphAlgo';

/** 节点定义（决策所需最小子集）。 */
export interface NodeDefView {
  typeId: string;
  inputs: Array<{ id: string }>;
  outputs: Array<{ id: string }>;
}

/** 缓存函数注入（避免本模块依赖 nodeCache/executorHelpers）。 */
export interface CacheHooks {
  collectInputs: (id: string, edges: FlowEdge[], outputsMap: Map<string, Record<string, unknown>>) => Record<string, unknown>;
  cacheKey: (typeId: string, params: Record<string, unknown>, upstream: Record<string, unknown>, scope: string) => string;
  getCached: (key: string) => Record<string, unknown> | null;
  getCachedBranches?: (key: string) => string[] | undefined;
}

/** decideNodeExecution 输入。 */
export interface NodeExecutionDecisionInput {
  id: string;
  node: FlowNode;
  def: NodeDefView | undefined;
  incoming: FlowEdge[];
  edges: FlowEdge[];
  outputsMap: Map<string, Record<string, unknown>>;
  branchState: Map<string, Set<string | undefined>>;
  cutSet: Set<string>;
  skipFailed?: boolean;
  /** resolveNodeExecutionMode 结果（前置模式判定） */
  mode: NodeExecutionMode;
  forced: boolean;
  isolated?: boolean;
  /** 缓存 scope（跨工作流隔离） */
  cacheScope: string;
  cacheHooks: CacheHooks;
}

/** 统一决策结果：调用方据此执行副作用。 */
export type NodeDecision =
  | { kind: 'upstream-failed' }
  | { kind: 'missing-def'; typeId: string }
  | { kind: 'bypass'; outputs: Record<string, unknown> }
  | { kind: 'mute' }
  | { kind: 'incremental-skip'; prevStatus?: NodeStatus }
  | { kind: 'pruned' }
  | { kind: 'cut' }
  | { kind: 'cached'; outputs: Record<string, unknown>; branches?: string[] }
  | { kind: 'execute' };

/** 前置决策（纯函数）。 */
export function decideNodeExecution(input: NodeExecutionDecisionInput): NodeDecision {
  const {
    id,
    node,
    def,
    incoming,
    edges,
    outputsMap,
    branchState,
    cutSet,
    skipFailed,
    mode,
    forced,
    isolated,
    cacheScope,
    cacheHooks,
  } = input;

  // ① 前置模式判定（resolveNodeExecutionMode 结果）：upstream-failed / missing-def / bypass / mute / incremental-skip / execute
  switch (mode.kind) {
    case 'upstream-failed':
      return { kind: 'upstream-failed' };
    case 'missing-def':
      return { kind: 'missing-def', typeId: node.data.typeId };
    case 'bypass':
      return { kind: 'bypass', outputs: bypassOutputs(id, def, incoming, outputsMap) };
    case 'mute':
      return { kind: 'mute' };
    case 'incremental-skip':
      return { kind: 'incremental-skip', prevStatus: mode.prevStatus };
    case 'execute':
      break; // 继续②
  }

  // ② 分支剪枝：所有入边来自「分支节点且未被激活」的分支 → 整条子图跳过
  if (incoming.length > 0 && isBranchPruned(incoming, branchState, skipFailed ?? false)) {
    return { kind: 'pruned' };
  }

  // ③ stopAfter 裁剪
  if (cutSet.has(id)) {
    return { kind: 'cut' };
  }

  // ④ 缓存命中判断（forced 时已在 runWorkflow 内 strike，跳过缓存）
  if (!forced) {
    const upstreamOutputs = isolated ? {} : cacheHooks.collectInputs(id, edges, outputsMap);
    const key = cacheHooks.cacheKey(node.data.typeId, node.data.params ?? {}, upstreamOutputs, cacheScope);
    const cached = cacheHooks.getCached(key);
    if (cached) {
      return {
        kind: 'cached',
        outputs: cached,
        branches: cacheHooks.getCachedBranches?.(key),
      };
    }
  }

  return { kind: 'execute' };
}

/** bypass：同名端口透传（上游输入端口值 → 同 id 输出端口）。 */
function bypassOutputs(
  id: string,
  def: NodeDefView | undefined,
  incoming: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!def) return out;
  for (const e of incoming) {
    const inPort = def.inputs.find((i) => i.id === e.targetHandle);
    if (!inPort) continue;
    const outPort = def.outputs.find((o) => o.id === inPort.id);
    if (!outPort) continue;
    const upstreamOut = outputsMap.get(e.source);
    out[outPort.id] = upstreamOut ? upstreamOut[e.sourceHandle ?? ''] : undefined;
  }
  void id;
  return out;
}

/** 分支剪枝判定（与 graphAlgo.isBranchPruned 一致）。 */
export function isBranchPruned(
  incoming: FlowEdge[],
  branchState: Map<string, Set<string | undefined>>,
  skipFailed: boolean,
): boolean {
  if (skipFailed) return false;
  return incoming.every((e) => {
    const active = branchState.get(e.source);
    if (!active) return false; // 未登记 = 全部激活
    if (active.size === 0) return true; // 空集合 = 全屏蔽
    return !active.has(e.sourceHandle ?? undefined);
  });
}
