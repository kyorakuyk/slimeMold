import type { SubgraphDef } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types';
import { flattenSubgraphs } from './subgraph';
import { topoStages } from './topoSort';
import { collectReachable } from './graphAlgo';

export interface RunPlan {
  nodes: FlowNode[];
  edges: FlowEdge[];
  dataEdges: { source: string; target: string }[];
  controlEdges: { source: string; target: string }[];
  stages: string[][];
  cyclic: string[];
  loopGateIds: Set<string>;
  loopVarOf: Map<string, string>;
  maxLoopsOf: Map<string, number>;
  loopBodyOf: Map<string, Set<string>>;
  hasLoop: boolean;
}

/** 只根据图结构生成执行计划，不读取 store、不创建运行资源。 */
export function buildRunPlan(
  graphNodes: FlowNode[],
  graphEdges: FlowEdge[],
  subgraphs: Record<string, SubgraphDef>,
): RunPlan {
  const flat = flattenSubgraphs(graphNodes, graphEdges, subgraphs);
  const nodes = flat.nodes;
  const edges = flat.edges;
  const dataEdges = edges
    .filter((e) => (e.data?.kind ?? 'data') !== 'control')
    .map((e) => ({ source: e.source, target: e.target }));
  const controlEdges = edges
    .filter((e) => (e.data?.kind ?? 'data') === 'control')
    .map((e) => ({ source: e.source, target: e.target }));

  const loopGates = nodes.filter((n) => n.data.typeId === 'flow.loopGate');
  const loopGateIds = new Set(loopGates.map((n) => n.id));
  // loopGate 的 control 出边是「向下游触发循环体」的正向边：其 target 不参与 Pass A 分层
  // （control 边被忽略），可能被错误排到 loop 之前。把 loopGate id 传给 topoStages，
  // 使 Pass B 对这些出边一律抬高 target 到 loop 之后（loop 先判断 → 再触发循环体）。
  const { stages, cyclic } = topoStages(
    nodes.map((n) => n.id),
    dataEdges,
    controlEdges,
    loopGateIds,
  );
  const loopVarOf = new Map<string, string>();
  const maxLoopsOf = new Map<string, number>();
  for (const gate of loopGates) {
    loopVarOf.set(gate.id, String((gate.data.params as Record<string, unknown>)?.loopVar ?? 'i'));
    maxLoopsOf.set(gate.id, Number((gate.data.params as Record<string, unknown>)?.maxLoops ?? 20));
  }

  // hasLoop 判定：loopGate 节点存在 control 出边（pass 端口）即视为有循环。
  // 不再要求「从 control 边 target 沿 data/control 边绕回 loopGate」（之前的图论环检测
  // 对 `loopGate.pass → split.rerun` 这类「control 边作为重派信号」的拓扑漏判，
  // 导致 maxLoops 失效、循环只跑 1 轮）。
  // 副作用：若用户错误给 loopGate 连了 control 出边但不想循环，会被误判；
  // 但该情形罕见、且启用循环不致命（只多跑几轮直到条件为假或达 maxRounds）。
  const hasLoop = loopGates.length > 0 &&
    controlEdges.some((e) => loopGateIds.has(e.source));
  const loopBodyOf = new Map<string, Set<string>>();
  if (hasLoop) {
    for (const gate of loopGates) {
      const body = new Set<string>();
      const seeds = controlEdges.filter((e) => e.source === gate.id).map((e) => e.target);
      for (const seed of seeds) collectReachable(seed, gate.id, edges, body);
      loopBodyOf.set(gate.id, body);
    }
  }

  return {
    nodes,
    edges,
    dataEdges,
    controlEdges,
    stages,
    cyclic,
    loopGateIds,
    loopVarOf,
    maxLoopsOf,
    loopBodyOf,
    hasLoop,
  };
}
