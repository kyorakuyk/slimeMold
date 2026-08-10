/**
 * workflowGraph.ts — workflowStore 图编辑纯逻辑段（G5 门面化第一步）。
 *
 * 把 workflowStore 里「可独立测试的纯映射/纯计算」下沉：
 * - markDirtyDownstream：从某节点出发沿边 BFS 收集下游（含自身）
 * - sanitizeForClipboard：复制时清洗节点运行态字段
 * - remapPasted：粘贴时 id 映射 + 位置偏移
 * - snapshotPush / snapshotUndo / snapshotRedo：撤销/重做历史栈纯逻辑
 *
 * 设计原则：纯函数，不触碰 store 单例 / IO / 运行态；只依赖输入参数 + 类型。
 * workflowStore.ts 调用这些函数替换内联逻辑，对外 API 与行为完全不变。
 */
import type { EdgeKind, FlowEdge, FlowNode, NodeDefinition, NodeStatus, PortDef, PortType, SubgraphDef } from '../types';

/** 撤销/重做的历史快照：仅含图本体（节点/连线），排除运行态与 UI 态 */
export interface GraphSnapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** 从某节点出发、沿边可到达的所有下游节点 id（含自身）。BFS，纯计算。 */
export function markDirtyDownstream(
  nodes: FlowNode[],
  edges: FlowEdge[],
  startId: string,
): Set<string> {
  const downstream = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !downstream.has(e.target)) {
        downstream.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return downstream;
}

/** 复制选中节点时清洗运行态字段（status/error/durationMs/cached 归零）。纯映射。 */
export function sanitizeForClipboard(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      status: 'idle' as NodeStatus,
      error: undefined,
      durationMs: undefined,
      cached: undefined,
    },
  }));
}

/** 粘贴剪贴板：为每个节点生成新 id + 位置偏移，边按 idMap 重连。纯函数，返回 {nodes, edges, firstId}。 */
export function remapPasted(
  clip: GraphSnapshot,
  offset = 40,
): { nodes: FlowNode[]; edges: FlowEdge[]; firstId: string | null } {
  const idMap = new Map<string, string>();
  const newNodes: FlowNode[] = clip.nodes.map((n) => {
    const newId = crypto.randomUUID();
    idMap.set(n.id, newId);
    return {
      ...n,
      id: newId,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      selected: true,
    };
  });
  const newEdges: FlowEdge[] = clip.edges.map((e) => ({
    ...e,
    id: crypto.randomUUID(),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
  }));
  return { nodes: newNodes, edges: newEdges, firstId: newNodes[0]?.id ?? null };
}

/** 压入历史快照：追加到 past 末尾、超出 maxHistory 丢弃最旧、清空 future。纯函数。 */
export function snapshotPush(
  past: GraphSnapshot[],
  nodes: FlowNode[],
  edges: FlowEdge[],
  maxHistory: number,
  sanitize: (n: FlowNode[]) => FlowNode[],
): { past: GraphSnapshot[]; future: GraphSnapshot[] } {
  const snap: GraphSnapshot = { nodes: sanitize(nodes), edges: [...edges] };
  const next = [...past, snap];
  if (next.length > maxHistory) next.splice(0, next.length - maxHistory);
  return { past: next, future: [] };
}

/** 撤销：把 past 末尾快照恢复到 nodes/edges，当前态进 future。返回 null 表示无可撤销。 */
export function snapshotUndo(
  past: GraphSnapshot[],
  future: GraphSnapshot[],
  nodes: FlowNode[],
  edges: FlowEdge[],
  sanitize: (n: FlowNode[]) => FlowNode[],
): { nodes: FlowNode[]; edges: FlowEdge[]; past: GraphSnapshot[]; future: GraphSnapshot[] } | null {
  if (past.length === 0) return null;
  const prev = past[past.length - 1];
  const current: GraphSnapshot = { nodes: sanitize(nodes), edges: [...edges] };
  return {
    nodes: sanitize(prev.nodes),
    edges: [...prev.edges],
    past: past.slice(0, -1),
    future: [...future, current],
  };
}

/** 重做：把 future 末尾快照恢复到 nodes/edges，当前态进 past。返回 null 表示无可重做。 */
export function snapshotRedo(
  past: GraphSnapshot[],
  future: GraphSnapshot[],
  nodes: FlowNode[],
  edges: FlowEdge[],
  sanitize: (n: FlowNode[]) => FlowNode[],
): { nodes: FlowNode[]; edges: FlowEdge[]; past: GraphSnapshot[]; future: GraphSnapshot[] } | null {
  if (future.length === 0) return null;
  const nextSnap = future[future.length - 1];
  const current: GraphSnapshot = { nodes: sanitize(nodes), edges: [...edges] };
  return {
    nodes: sanitize(nextSnap.nodes),
    edges: [...nextSnap.edges],
    past: [...past, current],
    future: future.slice(0, -1),
  };
}

/* ---------------- onConnect 决策段（G5 门面化第二步） ---------------- */

/** 连线决策结果：通过 → {ok, kind}；失败 → {ok:false, reason, message}。 */
export type ConnectDecision =
  | { ok: true; kind: EdgeKind }
  | { ok: false; reason: 'cycle' | 'incompatible'; message: string };

/** classifyConnection 依赖注入：端口解析 + 环检测 + 类型兼容判定（保持零 store 依赖）。 */
export interface ConnectDeps {
  /** 按节点实例解析端口（普通节点取类型定义，subgraph.ref 取子图定义） */
  resolvePorts: (
    typeId: string,
    params: Record<string, unknown> | undefined,
    defs: Record<string, NodeDefinition>,
    subgraphs: Record<string, SubgraphDef>,
  ) => { inputs: PortDef[]; outputs: PortDef[]; name: string };
  /** 新增边 source→target 后是否成环（忽略 control 边） */
  wouldCreateCycle: (source: string, target: string, edges: FlowEdge[]) => boolean;
  /** 端口类型兼容校验 */
  arePortsCompatible: (src: PortType | undefined, tgt: PortType | undefined) => boolean;
}

/**
 * onConnect 决策段纯函数：端口解析 → 环检测 → 类型校验 → kind 推断。
 * 返回统一决策，不直接改 store；副作用（addLog / set edges / markDirty）由调用方执行。
 * 与 workflowStore.onConnect 内联逻辑行为完全等价。
 */
export function classifyConnection(
  conn: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  nodes: FlowNode[],
  edges: FlowEdge[],
  defs: Record<string, NodeDefinition>,
  subgraphs: Record<string, SubgraphDef>,
  deps: ConnectDeps,
): ConnectDecision {
  const srcNode = nodes.find((n) => n.id === conn.source);
  const tgtNode = nodes.find((n) => n.id === conn.target);
  const srcDef = deps.resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, defs, subgraphs);
  const tgtDef = deps.resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, defs, subgraphs);
  const srcName = srcNode?.data.label ?? srcDef.name;
  const tgtName = tgtNode?.data.label ?? tgtDef.name;

  if (deps.wouldCreateCycle(conn.source, conn.target, edges)) {
    return {
      ok: false,
      reason: 'cycle',
      message: `「${srcName}」和「${tgtName}」这样连会绕成死循环，换一种接法吧`,
    };
  }
  // 端口类型校验：source 输出端口类型须与 target 输入端口类型兼容
  const srcPort = srcDef.outputs.find((o) => o.id === conn.sourceHandle);
  const tgtPort = tgtDef.inputs.find((i) => i.id === conn.targetHandle);
  const srcType: PortType | undefined = srcPort?.type;
  const tgtType: PortType | undefined = tgtPort?.type;
  if (!deps.arePortsCompatible(srcType, tgtType)) {
    // 在目标节点上找一个兼容的输入端口，给出更友好的引导
    const suggest = tgtDef.inputs.find((i) => deps.arePortsCompatible(srcType, i.type));
    const srcLabel = srcPort?.label ?? '输出';
    const tgtLabel = tgtPort?.label ?? '输入';
    const hint = suggest
      ? `可以把「${srcName}」的「${srcLabel}」连到「${tgtName}」的「${suggest.label}」端口`
      : `「${srcName}」提供的内容类型，和「${tgtName}」需要的对不上`;
    return {
      ok: false,
      reason: 'incompatible',
      message: `这条线连不上：「${srcName}」的「${srcLabel}」和「${tgtName}」的「${tgtLabel}」内容类型不一样。${hint}`,
    };
  }
  // 推断连线语义：默认 'data'，若 source 输出端口声明了 flow 则采用该语义
  const kind = (srcPort?.flow as EdgeKind | undefined) ?? 'data';
  return { ok: true, kind };
}
