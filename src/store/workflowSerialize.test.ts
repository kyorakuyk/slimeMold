import { describe, it, expect } from 'vitest';
import type { FlowEdge, FlowNode } from '../types';
import {
  sanitizeNodes,
  flowNodesFrom,
  flowEdgesFrom,
  storedNodeOf,
  storedEdgeOf,
  fromDisk,
  toDisk,
  serializeCurrent,
  buildProjectFile,
} from './workflowSerialize';

function mkNode(id: string, extra: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 10, y: 20 },
    data: {
      typeId: 'input.text',
      label: '节点' + id,
      params: { a: 1 },
      status: 'success',
      error: 'boom',
      durationMs: 12,
      dirty: true,
      bypass: false,
      mute: false,
      ...extra,
    },
  } as FlowNode;
}

function mkEdge(id: string, source: string, target: string): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data', scope: ['s1'] },
  } as FlowEdge;
}

describe('workflowSerialize 纯函数（从 workflowStore 抽离，行为等价）', () => {
  describe('sanitizeNodes', () => {
    it('清除运行态字段（status/error/durationMs/cached），保留其余', () => {
      const out = sanitizeNodes([mkNode('n1')]);
      expect(out[0].data.status).toBe('idle');
      expect(out[0].data.error).toBeUndefined();
      expect(out[0].data.durationMs).toBeUndefined();
      expect(out[0].data.cached).toBeUndefined();
      expect(out[0].data.typeId).toBe('input.text');
      expect(out[0].data.params).toEqual({ a: 1 });
    });
  });

  describe('toDisk / fromDisk 往返', () => {
    const nodes = [mkNode('n1'), mkNode('n2')];
    const edges = [mkEdge('e1', 'n1', 'n2')];

    it('toDisk 拍平剥离 React Flow 瞬态字段', () => {
      const wf = toDisk({ name: 'wf', nodes, edges } as never);
      expect(wf.nodes[0]).toEqual({
        id: 'n1',
        typeId: 'input.text',
        label: '节点n1',
        position: { x: 10, y: 20 },
        params: { a: 1 },
        bypass: false,
        mute: false,
      });
      // 运行态不应进入磁盘态
      expect((wf.nodes[0] as unknown as Record<string, unknown>).status).toBeUndefined();
      expect((wf.nodes[0] as unknown as Record<string, unknown>).data).toBeUndefined();
      expect(wf.edges[0]).toEqual({
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'out',
        targetHandle: 'in',
        kind: 'data',
        scope: ['s1'],
      });
    });

    it('fromDisk 还原回 FlowNode 且标记为脏', () => {
      const wf = toDisk({ name: 'wf', nodes, edges } as never);
      const back = fromDisk(wf);
      expect(back.nodes).toHaveLength(2);
      expect(back.nodes[0].id).toBe('n1');
      expect(back.nodes[0].type).toBe('base');
      expect(back.nodes[0].data.dirty).toBe(true);
      expect(back.nodes[0].data.status).toBe('idle');
      expect(back.edges[0].id).toBe('e1');
    });

    it('storedNodeOf / flowNodesFrom 单函数等价性', () => {
      expect(storedNodeOf(nodes[0])).toEqual({
        id: 'n1',
        typeId: 'input.text',
        label: '节点n1',
        position: { x: 10, y: 20 },
        params: { a: 1 },
        bypass: false,
        mute: false,
      });
      expect(flowNodesFrom(toDisk({ name: 'wf', nodes, edges } as never))[0].data.label).toBe('节点n1');
    });

    it('storedEdgeOf / flowEdgesFrom 单函数等价性', () => {
      expect(storedEdgeOf(edges[0])).toEqual({
        id: 'e1',
        source: 'n1',
        sourceHandle: 'out',
        target: 'n2',
        targetHandle: 'in',
        kind: 'data',
        scope: ['s1'],
      });
      expect(flowEdgesFrom(toDisk({ name: 'wf', nodes, edges } as never))[0].source).toBe('n1');
    });
  });

  describe('serializeCurrent', () => {
    it('把节点标记为脏且带版本/名称', () => {
      const wf = serializeCurrent({
        workflowName: '我的流',
        nodes: [mkNode('n1')],
        edges: [],
        agents: [],
        roles: [],
        variables: {},
      });
      expect(wf.name).toBe('我的流');
      expect(wf.version).toBe(1);
      expect(wf.nodes[0].data.dirty).toBe(true);
      expect(wf.assets).toEqual([]);
    });
    it('保留归属与资产', () => {
      const wf = serializeCurrent(
        { workflowName: 'x', nodes: [], edges: [], agents: [], roles: [], variables: {} },
        { belongsToProject: 'p1', standalonePath: '/a/b' },
        [{ id: 'a1', name: 'f', path: 'p', kind: 'text', content: 'x', createdAt: '2026-01-01T00:00:00.000Z', inWorkspace: false }],
      );
      expect(wf.belongsToProject).toBe('p1');
      expect(wf.standalonePath).toBe('/a/b');
      expect(wf.assets).toHaveLength(1);
    });
  });

  describe('buildProjectFile', () => {
    it('组装多工作流并拍平落盘', () => {
      const pf = buildProjectFile({
        workflowName: '主',
        nodes: [mkNode('n1')],
        edges: [mkEdge('e1', 'n1', 'n2')],
        agents: [],
        roles: [],
        variables: { v: 1 },
        projectVariables: { pv: 2 },
        projectAssets: [],
        groups: [],
        activeWfId: 'wfA',
        workflows: {
          wfA: { name: 'A', nodes: [mkNode('n1')], edges: [] } as never,
          wfB: { name: 'B', nodes: [], edges: [] } as never,
        },
        projectName: '项目',
        projectId: 'pid',
        projectCreatedAt: '2026-01-01T00:00:00.000Z',
        subgraphs: {},
        runHistory: [],
        artifacts: { handoffs: {}, received: {} },
        agentRouteTable: {},
        pipelines: [],
      });
      expect(pf.kind).toBe('project');
      expect(pf.name).toBe('项目');
      expect(Object.keys(pf.workflows)).toEqual(['wfA', 'wfB']);
      // 落盘态应是拍平节点（无 data 运行态）
      expect((pf.workflows.wfA.nodes[0] as unknown as Record<string, unknown>).typeId).toBe('input.text');
      expect((pf.workflows.wfA.nodes[0] as unknown as Record<string, unknown>).data).toBeUndefined();
      expect(pf.variables).toEqual({ pv: 2 });
      expect((pf.runs ?? { history: [] }).history).toEqual([]);
    });
  });
});
