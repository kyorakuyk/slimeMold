/**
 * graphAlgo.ts — 执行引擎的「纯图算法」内核。
 *
 * 这些函数只依赖节点图结构（FlowNode / FlowEdge），不触碰 store / LLM / 代次状态，
 * 因此可被 Vitest 在 node 环境下直接单测覆盖，而无需启动整个运行态。
 * 它们从 executor.ts 抽取而来，源码行为保持零回归。
 */
import type { FlowEdge } from '../types';

/** 将 startId 的全部下游节点收集进一个 Set（BFS），含 startId 自身。返回新集合，不改入参。 */
export function computeDownstream(startId: string, edges: FlowEdge[]): Set<string> {
  const cutSet = new Set<string>();
  const queue = [startId];
  const seen = new Set([startId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !seen.has(e.target)) {
        seen.add(e.target);
        cutSet.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return cutSet;
}

/** 沿任意边从 from 出发能否到达 target（用于检测 loopGate 的 control 回环）。 */
export function isReachable(from: string, target: string, edges: FlowEdge[]): boolean {
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === target) return true;
    for (const e of edges) {
      if (e.source === cur && !seen.has(e.target)) {
        seen.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return false;
}

/**
 * 收集从 start 出发、能绕回 gateId（未经过 gateId 自身）的可达节点集合，
 * 即「循环体」——这些节点在每轮迭代中需强制重算。结果写入 out（调用方持有），不返回。
 */
export function collectReachable(
  start: string,
  gateId: string,
  edges: FlowEdge[],
  out: Set<string>,
): void {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === gateId) continue; // 不把 gate 本身算进 body
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.add(cur);
    for (const e of edges) {
      if (e.source === cur && e.target !== gateId) queue.push(e.target);
    }
  }
}

/**
 * 计算每条 task 连线的目标节点所声明的影响域（scope）。
 * scope 经 task 边反向传播到目标节点：某目标节点的 scope = 所有指向它的 task 边 data.scope 的并集。
 */
export function scopesOfNode(id: string, edges: FlowEdge[]): string[] {
  const set = new Set<string>();
  for (const e of edges) {
    if (e.target === id && Array.isArray(e.data?.scope)) {
      for (const s of e.data.scope as string[]) set.add(s);
    }
  }
  return [...set];
}

/**
 * B-full 串行化：同一调度层（layer）内，若多个节点通过 task 边声明了**相交的影响域(scope)**，
 * 说明它们会争用同一资源，强制把它们归到同一「串行簇」内按序执行，消解并发冲突；
 * 互不冲突的节点仍保持并行（簇间并行、簇内串行），最大化并行度。
 *
 * 返回簇列表（每个簇是 layer 内节点的子集，簇内顺序即串行执行顺序）。
 * 基于冲突关系（scope 相交）的并查集：冲突的节点强制并入同一串行簇，
 * 不同连通分量之间仍并行（替代朴素贪心，避免多对冲突时错误分组）。
 */
export function computeScopeClusters(layer: string[], edges: FlowEdge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // 预先把本层所有节点初始化进并查集，避免内层访问未初始化节点导致 find 返回 undefined
  for (const id of layer) parent.set(id, id);
  for (const id of layer) {
    const sc = scopesOfNode(id, edges);
    // 找本层内与当前节点 scope 相交的其他节点，标记冲突并合并
    for (const other of layer) {
      if (other === id) continue;
      const os = scopesOfNode(other, edges);
      if (sc.some((s) => os.includes(s))) union(id, other);
    }
  }
  const groupOf = new Map<string, string[]>();
  for (const id of layer) {
    const root = find(id);
    if (!groupOf.has(root)) groupOf.set(root, []);
    groupOf.get(root)!.push(id);
  }
  return [...groupOf.values()];
}
