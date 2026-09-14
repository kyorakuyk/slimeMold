import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowNode } from '../types';
import { compileExecutionPlan } from './executionKernel';

function node(
  id: string,
  options: { dirty?: boolean; status?: FlowNode['data']['status']; typeId?: string; maxLoops?: number } = {},
): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: {
      typeId: options.typeId ?? 'test.node',
      label: id,
      params: options.maxLoops === undefined ? {} : { maxLoops: options.maxLoops },
      status: options.status ?? 'idle',
      dirty: options.dirty ?? false,
      bypass: false,
      mute: false,
    },
  } as unknown as FlowNode;
}

function edge(id: string, source: string, target: string): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data' },
  } as unknown as FlowEdge;
}

describe('compileExecutionPlan', () => {
  it('compiles a deterministic execution plan without mutating graph inputs', () => {
    const nodes = [node('a', { dirty: true }), node('b')];
    const edges = [edge('e1', 'a', 'b')];
    const options = { incremental: true, forceNodes: ['b'], stopAfterNodes: ['a'] };

    const plan = compileExecutionPlan(nodes, edges, {}, options);

    expect(plan.nodes).toEqual(nodes);
    expect(plan.edges).toEqual(edges);
    expect(plan.force).toEqual(new Set(['b']));
    expect(plan.dirtySet).toEqual(new Set(['a', 'b']));
    expect(plan.stopAfter).toEqual(new Set(['a']));
    expect(plan.isolatedIds).toBeUndefined();
    expect(plan.stages).toEqual([['a'], ['b']]);
    expect(plan.clusterPlan).toEqual([[['a']], [['b']]]);
    expect(nodes[0]?.data.dirty).toBe(true);
    expect(options.forceNodes).toEqual(['b']);
  });

  it('expands retryFailed to the failed node and every downstream node', () => {
    const nodes = [
      node('a', { status: 'error' }),
      node('b'),
      node('c'),
      node('independent'),
    ];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];

    const plan = compileExecutionPlan(nodes, edges, {}, { incremental: true, retryFailed: true });

    expect(plan.force).toEqual(new Set(['a', 'b', 'c']));
    expect(plan.dirtySet).toEqual(new Set(['a', 'b', 'c']));
    expect(plan.dirtySet.has('independent')).toBe(false);
  });

  it('derives loop round limits from the graph and honors an explicit override', () => {
    const nodes = [node('gate', { typeId: 'flow.loopGate', maxLoops: 7 })];

    expect(compileExecutionPlan(nodes, [], {}, {}).maxRounds).toBe(7);
    expect(compileExecutionPlan(nodes, [], {}, { maxLoopsOverride: 3 }).maxRounds).toBe(3);
  });
});
