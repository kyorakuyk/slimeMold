/**
 * workflowGraph.test.ts — G5 门面化：图编辑纯逻辑单测。
 *
 * 覆盖：markDirtyDownstream（BFS 下游收集）、sanitizeForClipboard（运行态清洗）、
 * remapPasted（id 映射 + 位置偏移）、snapshotPush/Undo/Redo（历史栈）、
 * classifyConnection（连线决策）、expandSubgraphInstance（子图展开）。
 */
import { describe, it, expect } from 'vitest';
import type { FlowNode, FlowEdge, NodeDefinition, PortDef, SubgraphDef, SubgraphPort } from '../types';
import {
  classifyConnection,
  expandSubgraphInstance,
  markDirtyDownstream,
  sanitizeForClipboard,
  remapPasted,
  snapshotPush,
  snapshotUndo,
  snapshotRedo,
  type ConnectDecision,
  type GraphSnapshot,
} from './workflowGraph';

const mkNode = (id: string, extra?: Partial<FlowNode>): FlowNode =>
  ({
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'x', label: id, params: {}, status: 'idle', dirty: true },
    ...extra,
  }) as unknown as FlowNode;

const mkEdge = (id: string, source: string, target: string): FlowEdge =>
  ({ id, source, target, data: {} }) as unknown as FlowEdge;

const sanitize = (n: FlowNode[]) => n; // 测试中不额外清洗

describe('markDirtyDownstream BFS 下游收集', () => {
  it('收集自身与全部下游（含跨层）', () => {
    const nodes = [mkNode('a'), mkNode('b'), mkNode('c'), mkNode('d')];
    const edges = [
      mkEdge('e1', 'a', 'b'),
      mkEdge('e2', 'b', 'c'),
      mkEdge('e3', 'c', 'd'),
    ];
    expect([...markDirtyDownstream(nodes, edges, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('分支下游全部收集', () => {
    const edges = [
      mkEdge('e1', 'a', 'b'),
      mkEdge('e2', 'a', 'c'),
      mkEdge('e3', 'c', 'd'),
    ];
    expect([...markDirtyDownstream([], edges, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('上游不收集（反向边不遍历）', () => {
    const edges = [
      mkEdge('e1', 'a', 'b'),
      mkEdge('e2', 'b', 'c'),
    ];
    expect([...markDirtyDownstream([], edges, 'c')].sort()).toEqual(['c']);
  });
});

describe('sanitizeForClipboard 运行态清洗', () => {
  it('清空 status/error/durationMs/cached，保留 id/position/data', () => {
    const n = mkNode('a', { data: { typeId: 'x', label: 'a', params: {}, status: 'running' as const, dirty: true, error: 'boom', durationMs: 123 } } as never);
    const out = sanitizeForClipboard([n]);
    expect(out[0].id).toBe('a');
    expect(out[0].data.status).toBe('idle');
    expect(out[0].data.error).toBeUndefined();
    expect(out[0].data.durationMs).toBeUndefined();
  });
});

describe('remapPasted 粘贴 id 映射', () => {
  it('生成新 id + 位置偏移，边按 idMap 重连', () => {
    const a = mkNode('a', { position: { x: 10, y: 20 } });
    const b = mkNode('b', { position: { x: 100, y: 200 } });
    const clip: GraphSnapshot = { nodes: [a, b], edges: [mkEdge('e1', 'a', 'b')] };
    const { nodes, edges, firstId } = remapPasted(clip, 40);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    // 新 id 不应与旧 id 相同
    expect(nodes[0].id).not.toBe('a');
    expect(nodes[1].id).not.toBe('b');
    // 位置偏移
    expect(nodes[0].position.x).toBe(50);
    expect(nodes[0].position.y).toBe(60);
    expect(nodes[1].position.x).toBe(140);
    expect(nodes[1].position.y).toBe(240);
    // 边重连到新 id
    expect(edges[0].source).toBe(nodes[0].id);
    expect(edges[0].target).toBe(nodes[1].id);
    expect(firstId).toBe(nodes[0].id);
  });

  it('空剪贴板返回空结果', () => {
    const { nodes, edges, firstId } = remapPasted({ nodes: [], edges: [] });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(firstId).toBeNull();
  });
});

describe('历史栈 snapshotPush / Undo / Redo', () => {
  it('push 追加到 past、清空 future、超限丢最旧', () => {
    const { past: p1 } = snapshotPush([], [mkNode('a')], [], 3, sanitize);
    const { past: p2 } = snapshotPush(p1, [mkNode('a'), mkNode('b')], [], 3, sanitize);
    const { past: p3 } = snapshotPush(p2, [mkNode('a'), mkNode('b'), mkNode('c')], [], 3, sanitize);
    const { past: p4 } = snapshotPush(p3, [mkNode('a'), mkNode('b'), mkNode('c'), mkNode('d')], [], 3, sanitize);
    expect(p4).toHaveLength(3); // 超限丢最旧
  });

  it('undo 恢复 past 末尾、当前态进 future', () => {
    const snap1: GraphSnapshot = { nodes: [mkNode('a')], edges: [] };
    const snap2: GraphSnapshot = { nodes: [mkNode('a'), mkNode('b')], edges: [] };
    const r = snapshotUndo([snap1, snap2], [], [mkNode('a'), mkNode('b'), mkNode('c')], [], sanitize);
    expect(r).not.toBeNull();
    expect(r!.nodes).toHaveLength(2); // 恢复到 snap2
    expect(r!.past).toHaveLength(1);
    expect(r!.future).toHaveLength(1); // 当前态进 future
  });

  it('past 为空 undo 返回 null', () => {
    expect(snapshotUndo([], [], [], [], sanitize)).toBeNull();
  });

  it('redo 恢复 future 末尾、当前态进 past', () => {
    const snap1: GraphSnapshot = { nodes: [mkNode('a')], edges: [] };
    const snap2: GraphSnapshot = { nodes: [mkNode('a'), mkNode('b')], edges: [] };
    // 先 undo：future=[snap2]，再 redo 恢复
    const undone = snapshotUndo([snap1], [], [mkNode('a'), mkNode('b')], [], sanitize)!;
    const r = snapshotRedo(undone.past, undone.future, undone.nodes, undone.edges, sanitize);
    expect(r).not.toBeNull();
    expect(r!.nodes).toHaveLength(2);
    expect(r!.future).toHaveLength(0);
    expect(r!.past).toHaveLength(1);
  });

  it('future 为空 redo 返回 null', () => {
    expect(snapshotRedo([], [], [], [], sanitize)).toBeNull();
  });
});

describe('classifyConnection 连线决策', () => {
  const def = (typeId: string, inputs: PortDef[], outputs: PortDef[]): NodeDefinition =>
    ({ typeId, name: typeId, category: 'x', description: '', inputs, outputs, params: [], execute: async () => ({}) }) as unknown as NodeDefinition;
  const node = (id: string, typeId: string): FlowNode =>
    ({ id, type: 'base', position: { x: 0, y: 0 }, data: { typeId, label: id, params: {}, status: 'idle' } }) as unknown as FlowNode;

  const deps = {
    resolvePorts: (_t: string, _p: unknown, defs: Record<string, NodeDefinition>, _s: unknown) => {
      const d = defs[_t]!;
      return { inputs: d.inputs, outputs: d.outputs, name: d.name };
    },
    wouldCreateCycle: (_s: string, _t: string, edges: FlowEdge[]) => edges.length > 0,
    arePortsCompatible: (a: string | undefined, b: string | undefined) => a === b,
  };

  it('兼容端口 + 无环 → ok:true + kind=data', () => {
    const defs = { src: def('src', [], [{ id: 'out', label: 'o', type: 'text' }]), tgt: def('tgt', [{ id: 'in', label: 'i', type: 'text' }], []) };
    const d = classifyConnection({ source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }, [node('a', 'src'), node('b', 'tgt')], [], defs, {}, deps);
    expect(d).toEqual({ ok: true, kind: 'data' });
  });

  it('source 输出端口声明 flow:task → kind=task', () => {
    const defs = { src: def('src', [], [{ id: 'out', label: 'o', type: 'any', flow: 'task' }]), tgt: def('tgt', [{ id: 'in', label: 'i', type: 'any' }], []) };
    const d = classifyConnection({ source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }, [node('a', 'src'), node('b', 'tgt')], [], defs, {}, deps);
    expect(d).toEqual({ ok: true, kind: 'task' });
  });

  it('成环 → ok:false reason=cycle，消息含节点名', () => {
    const defs = { src: def('src', [], [{ id: 'out', label: 'o', type: 'text' }]), tgt: def('tgt', [{ id: 'in', label: 'i', type: 'text' }], []) };
    const d = classifyConnection({ source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }, [node('a', 'src'), node('b', 'tgt')], [mkEdge('e1', 'b', 'a')], defs, {}, deps);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('cycle');
      expect(d.message).toContain('死循环');
    }
  });

  it('类型不兼容 → ok:false reason=incompatible，消息含引导', () => {
    const defs = { src: def('src', [], [{ id: 'out', label: 'o', type: 'number' }]), tgt: def('tgt', [{ id: 'in', label: 'i', type: 'text' }, { id: 'num', label: 'num', type: 'number' }], []) };
    const d = classifyConnection({ source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }, [node('a', 'src'), node('b', 'tgt')], [], defs, {}, deps);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('incompatible');
      // 应引导到兼容的 num 端口
      expect(d.message).toContain('num');
    }
  });
});

describe('expandSubgraphInstance 子图展开', () => {
  const sg: SubgraphDef = {
    id: 'sg1',
    name: '子图',
    createdAt: '',
    updatedAt: '',
    nodes: [
      { id: 'in1', typeId: 'input.text', label: 'A', position: { x: 0, y: 0 }, params: {} },
      { id: 'mid', typeId: 'text.template', label: 'B', position: { x: 100, y: 0 }, params: {} },
    ],
    edges: [{ id: 'se1', source: 'in1', sourceHandle: 'text', target: 'mid', targetHandle: 'a' }],
    inputs: [{ id: 'p1', label: '入', type: 'text', innerNodeId: 'in1', innerHandle: 'text' }],
    outputs: [],
  };

  it('内部节点重新分配 id、位置相对 ref 缩放、内部边按新 id 重连', () => {
    const { nodes, edges } = expandSubgraphInstance(sg, { x: 200, y: 100 }, [], 'ref1');
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    // 新 id 不与旧 id 相同
    expect(nodes[0].id).not.toBe('in1');
    expect(nodes[1].id).not.toBe('mid');
    // 位置缩放
    expect(nodes[0].position.x).toBeCloseTo(200);
    expect(nodes[0].position.y).toBeCloseTo(100);
    expect(nodes[1].position.x).toBeCloseTo(235); // 200 + 100*0.35
    // 内部边重连
    expect(edges[0].source).toBe(nodes[0].id);
    expect(edges[0].target).toBe(nodes[1].id);
  });

  it('接在 ref 上的外部输入连线改接到内部节点端口', () => {
    // 外部边：source 节点 out 端口 → ref1 的 p1 端口（子图对外输入）
    const external: FlowEdge[] = [
      { id: 'x1', source: 'outA', sourceHandle: 'out', target: 'ref1', targetHandle: 'p1', data: {} } as FlowEdge,
    ];
    const { nodes, edges } = expandSubgraphInstance(sg, { x: 0, y: 0 }, external, 'ref1');
    // 内部边 1 + 外部重接 1（重接边会生成新 id，不能按原 id 找）
    expect(edges).toHaveLength(2);
    // 重接的外部边：source 保持 outA，target 应指向内部 in1 的新 id、targetHandle='text'
    const rerouted = edges.find((e) => e.source === 'outA');
    expect(rerouted).toBeTruthy();
    expect(rerouted!.target).toBe(nodes[0].id); // in1 的新 id（nodes[0] 是 in1 展开）
    expect(rerouted!.targetHandle).toBe('text');
    expect(rerouted!.target).not.toBe('ref1');
  });
});
