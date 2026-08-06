import { describe, it, expect } from 'vitest';
import {
  expandedId,
  ownerRefId,
  inferPorts,
  resolvePorts,
  flattenSubgraphs,
  SUBGRAPH_REF_TYPE,
} from './subgraph';
import type { NodeDefinition, SubgraphDef, FlowNode, FlowEdge } from '../types';

// 最小 NodeDefinition 工厂
function def(
  typeId: string,
  inputs: { id: string; label?: string; type?: string }[],
  outputs: { id: string; label?: string; type?: string }[],
): NodeDefinition {
  return {
    typeId,
    name: typeId,
    category: '测试',
    description: '',
    inputs: inputs.map((p) => ({ id: p.id, label: p.label ?? p.id, type: (p.type ?? 'any') as never })),
    outputs: outputs.map((p) => ({ id: p.id, label: p.label ?? p.id, type: (p.type ?? 'any') as never })),
    // execute 不会被测试调用
    execute: async () => ({}),
    params: [],
  } as unknown as NodeDefinition;
}

const defs: Record<string, NodeDefinition> = {
  'node.a': def('node.a', [{ id: 'in1' }], [{ id: 'out1' }]),
  'node.b': def('node.b', [{ id: 'in1' }], [{ id: 'out1' }]),
  'node.c': def('node.c', [{ id: 'in1' }, { id: 'in2' }], [{ id: 'out1' }]),
};

describe('expandedId / ownerRefId', () => {
  it('拼接与反解', () => {
    const e = expandedId('ref1', 'n1');
    expect(e).toBe('ref1::n1');
    expect(ownerRefId(e)).toBe('ref1');
  });

  it('普通节点 id 不含分隔符 -> ownerRefId 返回 null', () => {
    expect(ownerRefId('plainNode')).toBeNull();
  });

  it('分隔符出现在中间也能正确反解第一段', () => {
    expect(ownerRefId('ref::x::y')).toBe('ref');
  });
});

describe('inferPorts', () => {
  it('内部未被占用的端口提升为对外端口', () => {
    // a.out1 -> b.in1（内部连线），b.out1 无出边 -> 对外输出；a.in1 无入边 -> 对外输入
    const nodes = [
      { id: 'a', typeId: 'node.a', label: 'A', position: { x: 0, y: 0 }, params: {} },
      { id: 'b', typeId: 'node.b', label: 'B', position: { x: 1, y: 0 }, params: {} },
    ];
    const edges = [{ id: 'e1', source: 'a', sourceHandle: 'out1', target: 'b', targetHandle: 'in1' }];
    const { inputs, outputs } = inferPorts(nodes, edges, defs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ innerNodeId: 'a', innerHandle: 'in1' });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ innerNodeId: 'b', innerHandle: 'out1' });
  });

  it('被内部连线占用的端口不提升', () => {
    const nodes = [
      { id: 'a', typeId: 'node.a', label: 'A', position: { x: 0, y: 0 }, params: {} },
      { id: 'b', typeId: 'node.b', label: 'B', position: { x: 1, y: 0 }, params: {} },
    ];
    // a.in1 也有入边（来自外部视角之外的节点）——此处用虚拟节点 c 连入 a.in1
    const edges = [
      { id: 'e1', source: 'a', sourceHandle: 'out1', target: 'b', targetHandle: 'in1' },
      { id: 'e2', source: 'c', sourceHandle: 'out1', target: 'a', targetHandle: 'in1' },
    ];
    const { inputs } = inferPorts(nodes, edges, defs);
    // a.in1 被 e2 占用，不再提升为对外输入
    expect(inputs).toHaveLength(0);
  });

  it('未知 typeId 的节点被跳过', () => {
    const nodes = [{ id: 'z', typeId: 'missing', label: 'Z', position: { x: 0, y: 0 }, params: {} }];
    const { inputs, outputs } = inferPorts(nodes, [], defs);
    expect(inputs).toHaveLength(0);
    expect(outputs).toHaveLength(0);
  });
});

describe('resolvePorts', () => {
  const sg: SubgraphDef = {
    id: 'sg1',
    name: '子图1',
    category: '子图',
    createdAt: '',
    updatedAt: '',
    nodes: [],
    edges: [],
    inputs: [{ id: 'in_x', label: '输入', type: 'text', innerNodeId: 'a', innerHandle: 'in1' }],
    outputs: [{ id: 'out_x', label: '输出', type: 'text', innerNodeId: 'b', innerHandle: 'out1' }],
  };

  it('普通节点直接取定义端口', () => {
    const r = resolvePorts('node.a', {}, defs, { sg1: sg });
    expect(r.name).toBe('node.a');
    expect(r.inputs).toHaveLength(1);
    expect(r.outputs).toHaveLength(1);
  });

  it('subgraph.ref 节点取引用定义的端口', () => {
    const r = resolvePorts(SUBGRAPH_REF_TYPE, { subgraphId: 'sg1' }, defs, { sg1: sg });
    expect(r.name).toBe('子图1');
    expect(r.inputs[0]).toMatchObject({ id: 'in_x', type: 'text' });
    expect(r.outputs[0]).toMatchObject({ id: 'out_x', type: 'text' });
  });

  it('subgraph.ref 引用丢失时降级为空端口', () => {
    const r = resolvePorts(SUBGRAPH_REF_TYPE, { subgraphId: 'ghost' }, defs, { sg1: sg });
    expect(r.inputs).toHaveLength(0);
    expect(r.outputs).toHaveLength(0);
    expect(r.name).toContain('丢失');
  });
});

describe('flattenSubgraphs', () => {
  // 构造一个子图：内部 a -> b，a.in1 留给外部，b.out1 留给外部
  function makeSg(id: string): SubgraphDef {
    return {
      id,
      name: `SG_${id}`,
      category: '子图',
      createdAt: '',
      updatedAt: '',
      nodes: [
        { id: 'a', typeId: 'node.a', label: 'A', position: { x: 0, y: 0 }, params: {} },
        { id: 'b', typeId: 'node.b', label: 'B', position: { x: 1, y: 0 }, params: {} },
      ],
      edges: [{ id: 'e', source: 'a', sourceHandle: 'out1', target: 'b', targetHandle: 'in1' }],
      inputs: [{ id: 'in_a', label: 'A.in', type: 'any', innerNodeId: 'a', innerHandle: 'in1' }],
      outputs: [{ id: 'out_b', label: 'B.out', type: 'any', innerNodeId: 'b', innerHandle: 'out1' }],
    };
  }

  const sg = makeSg('sg1');
  const subgraphs = { sg1: sg };

  function refNode(id: string, sgId: string, position = { x: 10, y: 10 }): FlowNode {
    return {
      id,
      type: 'subgraph.ref',
      position,
      data: { typeId: SUBGRAPH_REF_TYPE, label: '引用', params: { subgraphId: sgId } },
    } as unknown as FlowNode;
  }

  it('无 ref 节点时原样返回', () => {
    const nodes: FlowNode[] = [refNode('r', 'sg1')];
    // 替换成非 ref
    nodes[0] = { id: 'x', type: 'base', position: { x: 0, y: 0 }, data: { typeId: 'node.a', label: 'A', params: {} } } as FlowNode;
    const r = flattenSubgraphs(nodes, [], subgraphs);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].id).toBe('x');
  });

  it('展开 ref 节点为内部节点（id 加前缀）', () => {
    const nodes = [refNode('r1', 'sg1')];
    const r = flattenSubgraphs(nodes, [], subgraphs);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['r1::a', 'r1::b']);
    // 内部 a->b 连线也被展开
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].source).toBe('r1::a');
    expect(r.edges[0].target).toBe('r1::b');
  });

  it('外部 -> ref 输入端口，连线重定向到内部节点', () => {
    const nodes: FlowNode[] = [
      { id: 'src', type: 'base', position: { x: 0, y: 0 }, data: { typeId: 'node.a', label: 'src', params: {} } } as FlowNode,
      refNode('r1', 'sg1'),
    ];
    const edges: FlowEdge[] = [
      { id: 'ext', source: 'src', sourceHandle: 'out1', target: 'r1', targetHandle: 'in_a' } as FlowEdge,
    ];
    const r = flattenSubgraphs(nodes, edges, subgraphs);
    expect(
      r.edges.some(
        (ed) => ed.source === 'src' && ed.target === 'r1::a' && ed.targetHandle === 'in1',
      ),
    ).toBe(true);
  });

  it('ref -> 外部 输出端口，连线源重定向到内部节点', () => {
    const nodes: FlowNode[] = [
      refNode('r1', 'sg1'),
      { id: 'dst', type: 'base', position: { x: 0, y: 0 }, data: { typeId: 'node.b', label: 'dst', params: {} } } as FlowNode,
    ];
    const edges: FlowEdge[] = [
      { id: 'ext', source: 'r1', sourceHandle: 'out_b', target: 'dst', targetHandle: 'in1' } as FlowEdge,
    ];
    const r = flattenSubgraphs(nodes, edges, subgraphs);
    expect(r.edges.some((ed) => ed.source === 'r1::b' && ed.sourceHandle === 'out1' && ed.target === 'dst')).toBe(true);
  });

  it('引用定义丢失时抛错', () => {
    const nodes = [refNode('r1', 'ghost')];
    expect(() => flattenSubgraphs(nodes, [], subgraphs)).toThrow(/定义已丢失/);
  });

  it('循环引用子图抛错', () => {
    // sgX 内部引用 sgX（通过构造一个 ref 节点在子图 nodes 里）
    const selfRef: SubgraphDef = {
      ...sg,
      id: 'sgX',
      nodes: [{ id: 'ref', typeId: SUBGRAPH_REF_TYPE, label: 'self', position: { x: 0, y: 0 }, params: { subgraphId: 'sgX' } }],
      edges: [],
    };
    // 顶层放一个引用 sgX 的 ref 节点
    const nodes = [refNode('top', 'sgX')];
    expect(() => flattenSubgraphs(nodes, [], { sgX: selfRef })).toThrow(/循环引用/);
  });
});
