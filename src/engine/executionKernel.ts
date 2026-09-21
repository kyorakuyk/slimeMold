/**
 * executionKernel.ts — pure execution-plan compilation.
 *
 * This is the first physical boundary of the execution engine split. It owns
 * deterministic planning only: graph expansion, execution-set calculation,
 * retry scope, stage clustering, and loop limits. It does not read the store,
 * allocate resources, execute nodes, or persist facts.
 */
import type { SubgraphDef } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types';
import { computeDownstream, computeExecutionSet, planClustersPerStage } from './graphAlgo';
import { buildRunPlan, type RunPlan } from './runPlan';

export interface ExecutionKernelOptions {
  incremental?: boolean;
  retryFailed?: boolean;
  forceNodes?: readonly string[];
  stopAfterNodes?: readonly string[];
  isolated?: boolean;
  maxLoopsOverride?: number;
}

export interface ExecutionKernelPlan extends RunPlan {
  /** Nodes explicitly forced, including retryFailed downstream scope. */
  force: Set<string>;
  /** Nodes that must be considered for execution in this run. */
  dirtySet: Set<string>;
  /** Downstream nodes cut by stopAfter. */
  stopAfter: Set<string>;
  /** Isolated execution scope, when single-node mode is enabled. */
  isolatedIds?: Set<string>;
  /** Per-stage serialized conflict clusters. */
  clusterPlan: string[][][];
  /** Maximum loop rounds for this run. */
  maxRounds: number;
}

/**
 * Compile the deterministic part of a workflow run without mutating inputs.
 *
 * The returned plan is the handoff from control/scheduling setup to runtime
 * execution. Side effects such as cache invalidation and node status writes
 * deliberately remain outside this function.
 */
export function compileExecutionPlan(
  graphNodes: FlowNode[],
  graphEdges: FlowEdge[],
  subgraphs: Record<string, SubgraphDef>,
  options: ExecutionKernelOptions,
): ExecutionKernelPlan {
  const runPlan = buildRunPlan(graphNodes, graphEdges, subgraphs);
  const force = new Set(options.forceNodes ?? []);

  if (options.retryFailed) {
    for (const failedNode of runPlan.nodes) {
      if (failedNode.data.status !== 'error') continue;
      // retryFailed must rerun the failed node itself as well as its downstream.
      force.add(failedNode.id);
      for (const downstream of computeDownstream(failedNode.id, runPlan.edges)) {
        force.add(downstream);
      }
    }
  }

  const { dirtySet } = computeExecutionSet(runPlan.nodes, {
    incremental: options.incremental,
    retryFailed: options.retryFailed,
    forceNodes: [...force],
  });

  const maxRounds =
    options.maxLoopsOverride ??
    Math.min(50, Math.max(1, ...runPlan.maxLoopsOf.values()));

  return {
    ...runPlan,
    force,
    dirtySet,
    stopAfter: new Set(options.stopAfterNodes ?? []),
    isolatedIds: options.isolated ? new Set(options.forceNodes ?? []) : undefined,
    clusterPlan: planClustersPerStage(runPlan.stages, runPlan.edges),
    maxRounds,
  };
}
