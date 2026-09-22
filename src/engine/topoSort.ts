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

/** 判断新增边 source->target 后是否成环（用于连线时即时拦截）。
 * ignoreControl=true（默认）：忽略 control 语义边（条件/循环断点），
 * 允许「条件节点 → 循环体 → 回指条件节点」这类伪环存在而不误报。 */
export function wouldCreateCycle(
  source: string,
  target: string,
  edges: { source: string; target: string; data?: { kind?: string } }[],
  ignoreControl = true,
): boolean {
  if (source === target) return true;
  const eff = ignoreControl ? edges.filter((e) => (e.data?.kind ?? 'data') !== 'control') : edges;
  const adjacency = new Map<string, string[]>();
  for (const e of eff) {
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

/**
 * stage 化拓扑排序：把控制流（control）边视为「断点」，将图切成多个 stage。
 * - 仅 data/task 边参与 Kahn 分层（同 stage 内节点并行）。
 * - 每条 control 边 from→to 强制 to 及其 data/task 下游进入更高 stage，
 *   从而「条件/循环断点」不会破坏 DAG 检测，又能保证执行顺序。
 * 返回 stages（每个 stage 内可并行）与 cyclic（纯 data/task 成环的节点）。
 */
export interface StageResult {
  stages: string[][];
  cyclic: string[];
}

export function topoStages(
  nodeIds: string[],
  edges: { source: string; target: string }[],
  controlEdges: { source: string; target: string }[],
  forwardControlSources?: Set<string>,
): StageResult {
  // Pass A：仅 data/task 边做标准 Kahn 分层
  const { layers, cyclic } = topoLayers(nodeIds, edges);
  if (cyclic.length > 0) {
    return { stages: layers, cyclic };
  }

  // Pass B：沿 control 边把下游抬高到更高 stage。
  // 注意：回流边（control 的 target 已在 source 之前，如 council.backflow → architect.goal）
  // 不抬高——否则与 data 边 architect→council 互相追逐导致死循环。回流边语义是「断点」，
  // architect 先跑、council 后跑，backflow 回流 architect 属异步重派，不应把 architect 重排到最后。
  //
  // 例外：loopGate 的 pass 出口是「向下游触发循环体」的正向 control 边——它的 target
  // （循环体首节点）不参与 Pass A 分层（control 边被忽略），可能被错误排到 loop 之前。
  // forwardControlSources 标记这类 source（loopGate id），对其出边一律把 target 抬高到
  // source 之后，保证「loop 先判断 → 再触发循环体」。
  const stageOf = new Map<string, number>();
  layers.forEach((layer, i) => layer.forEach((id) => stageOf.set(id, i)));

  // data/task 邻接表，用于向下游传播 stage
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }

  // 迭代至稳定：仅当 control 边为「正向」（target 已在 source 之后，需进一步保证严格晚于）时抬高。
  // 回流边（target 已在 source 之前，如 council.backflow → architect.goal）跳过——否则与 data 边
  // a→b→c 互相追逐导致死循环；回流边语义是「断点」，architect 先跑、council 后跑，backflow 属异步重派。
  // loopGate 的 data 下游允许回流到 gate 本身，因此传播时不能再次抬高 gate；
  // 上限则作为多个相互回流 gate 的 fail-closed 保险，避免渲染线程无限循环。
  let changed = true;
  let iterations = 0;
  const maxIterations = Math.max(1, nodeIds.length * Math.max(1, controlEdges.length));
  while (changed && iterations < maxIterations) {
    iterations++;
    changed = false;
    for (const e of controlEdges) {
      const fs = stageOf.get(e.source);
      const ts = stageOf.get(e.target);
      if (fs == null || ts == null) continue;
      // loopGate 正向触发边：无条件把 target 抬高到 fs+1（即使 target 初始在 source 之前）
      if (forwardControlSources?.has(e.source)) {
        const need = fs + 1;
        const stack = [e.target];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (seen.has(cur) || cur === e.source) continue;
          seen.add(cur);
          const curS = stageOf.get(cur) ?? 0;
          if (curS < need) {
            stageOf.set(cur, need);
            changed = true;
          }
          for (const nxt of adjacency.get(cur) ?? []) stack.push(nxt);
        }
        continue;
      }
      if (ts <= fs) continue; // 回流边（target 已在 source 之前）跳过，避免互相抬高死循环
      const need = fs + 1;
      const stack = [e.target];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur) || cur === e.source) continue;
        seen.add(cur);
        const curS = stageOf.get(cur) ?? 0;
        if (curS < need) {
          stageOf.set(cur, need);
          changed = true;
        }
        for (const nxt of adjacency.get(cur) ?? []) stack.push(nxt);
      }
    }
  }

  if (changed) {
    // A control/data constraint cycle has no finite stage projection. Do not return a
    // partial plan that could be executed in an arbitrary order.
    return { stages: [], cyclic: [...nodeIds] };
  }

  const maxStage = nodeIds.reduce((m, id) => Math.max(m, stageOf.get(id) ?? 0), -1);
  const stages: string[][] = [];
  for (let i = 0; i <= maxStage; i++) stages.push([]);
  for (const id of nodeIds) stages[stageOf.get(id) ?? 0].push(id);
  return { stages, cyclic: [] };
}
