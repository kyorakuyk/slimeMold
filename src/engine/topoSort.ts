/**
 * Kahn 分层拓扑排序：同层节点无依赖关系，可并行执行。
 * 返回 layers（分层节点 id）与 cyclic（成环节点 id）。
 */
export interface TopoResult {
  layers: string[][];
  cyclic: string[];
}

export function topoLayers(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): TopoResult {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const e of edges) {
    if (!inDegree.has(e.source) || !inDegree.has(e.target)) continue;
    adjacency.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const layers: string[][] = [];
  let current = nodeIds.filter((id) => inDegree.get(id) === 0);
  const visited = new Set<string>();

  while (current.length > 0) {
    layers.push(current);
    const next: string[] = [];
    for (const id of current) {
      visited.add(id);
      for (const to of adjacency.get(id) ?? []) {
        const d = (inDegree.get(to) ?? 0) - 1;
        inDegree.set(to, d);
        if (d === 0) next.push(to);
      }
    }
    current = next;
  }

  return {
    layers,
    cyclic: nodeIds.filter((id) => !visited.has(id)),
  };
}

/** 判断新增边 source->target 后是否成环（用于连线时即时拦截） */
export function wouldCreateCycle(
  source: string,
  target: string,
  edges: { source: string; target: string }[],
): boolean {
  if (source === target) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }
  // 若从 target 可达 source，则加边成环
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adjacency.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}
