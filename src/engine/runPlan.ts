import type { FlowEdge, FlowNode, SubgraphDef } from '../types';
import { flattenSubgraphs } from './subgraph';
import { topoStages } from './topoSort';
import { collectReachable, isReachable } from './graphAlgo';

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
  const { stages, cyclic } = topoStages(
    nodes.map((n) => n.id),
    dataEdges,
    controlEdges,
  );

  const loopGates = nodes.filter((n) => n.data.typeId === 'flow.loopGate');
  const loopGateIds = new Set(loopGates.map((n) => n.id));
  const loopVarOf = new Map<string, string>();
  const maxLoopsOf = new Map<string, number>();
  for (const gate of loopGates) {
    loopVarOf.set(gate.id, String((gate.data.params as Record<string, unknown>)?.loopVar ?? 'i'));
    maxLoopsOf.set(gate.id, Number((gate.data.params as Record<string, unknown>)?.maxLoops ?? 20));
  }

  const hasLoop = loopGates.length > 0 &&
    controlEdges.some((e) => loopGateIds.has(e.source) && isReachable(e.target, e.source, edges));
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
