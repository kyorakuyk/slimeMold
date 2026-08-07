import { describe, expect, it } from 'vitest';
import { buildRunPlan } from './runPlan';
import type { FlowEdge, FlowNode } from '../types';

function node(id: string, typeId = 'input.text', params: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { typeId, label: id, params, status: 'idle' },
  } as FlowNode;
}

function edge(source: string, target: string, kind: 'data' | 'control' = 'data'): FlowEdge {
  return { id: `${source}-${target}`, source, target, data: { kind } } as FlowEdge;
}

describe('buildRunPlan', () => {
  it('分类边并生成拓扑阶段', () => {
    const plan = buildRunPlan([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c', 'control')], {});
    expect(plan.dataEdges).toEqual([{ source: 'a', target: 'b' }]);
    expect(plan.controlEdges).toEqual([{ source: 'b', target: 'c' }]);
    expect(plan.cyclic).toEqual([]);
    // control 边只作为断点抬升目标及其 data/task 下游；这里 c 不依赖 b 的 data 输出，
    // 因而与 a 同层，保持 topoStages 的既有语义。
    expect(plan.stages).toEqual([['a', 'c'], ['b']]);
  });

  it('识别 loopGate 及其循环体', () => {
    const plan = buildRunPlan(
      [node('gate', 'flow.loopGate', { loopVar: 'i', maxLoops: 3 }), node('body'), node('back')],
      [edge('gate', 'body', 'control'), edge('body', 'back'), edge('back', 'gate', 'control')],
      {},
    );
    expect(plan.hasLoop).toBe(true);
    expect(plan.loopGateIds).toEqual(new Set(['gate']));
    expect(plan.loopVarOf.get('gate')).toBe('i');
    expect(plan.maxLoopsOf.get('gate')).toBe(3);
    expect(plan.loopBodyOf.get('gate')).toEqual(new Set(['body', 'back']));
  });

  it('报告纯 data/task 环路', () => {
    const plan = buildRunPlan([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')], {});
    expect(plan.cyclic).toEqual(['a', 'b']);
  });
});
