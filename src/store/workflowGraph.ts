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
import type { FlowEdge, FlowNode, NodeStatus } from '../types';

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
