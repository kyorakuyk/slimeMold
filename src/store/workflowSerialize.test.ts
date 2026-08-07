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
  projectSnapshot,
  DIRTY_KEYS,
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

    it('往返后保留边语义 kind/scope（data 边）', () => {
      const wf = toDisk({ name: 'wf', nodes, edges } as never);
      const back = flowEdgesFrom(wf);
      expect(back[0].data).toEqual({ kind: 'data', scope: ['s1'] });
    });

    it('往返后保留 control/task 边语义 kind/scope', () => {
      const controlEdge: FlowEdge = {
        id: 'ec',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'cond',
        targetHandle: 'in',
        data: { kind: 'control' },
      } as FlowEdge;
      const taskEdge: FlowEdge = {
        id: 'et',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'dispatch',
        targetHandle: 'in',
        data: { kind: 'task', scope: ['src/*.ts', 'docs/**'] },
      } as FlowEdge;
      const wf = toDisk({ name: 'wf', nodes, edges: [controlEdge, taskEdge] } as never);
      const back = flowEdgesFrom(wf);
      expect(back[0].data).toEqual({ kind: 'control', scope: undefined });
      expect(back[1].data).toEqual({ kind: 'task', scope: ['src/*.ts', 'docs/**'] });
    });

    it('旧文件无 kind 字段时缺省回退为 data 边（向后兼容）', () => {
      const legacy = fromDisk({ name: 'wf', nodes: [], edges: [{ id: 'el', source: 'a', target: 'b' }] } as never);
      expect(legacy.edges[0].data).toEqual({ kind: 'data', scope: undefined });
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

  describe('projectSnapshot', () => {
    const base = {
      workflowName: '主',
      nodes: [mkNode('n1')],
      edges: [mkEdge('e1', 'n1', 'n2')],
      agents: [] as never[],
      roles: [] as never[],
      variables: { v: 1 },
      projectVariables: { pv: 2 },
      projectAssets: [] as never[],
      groups: [] as never[],
      activeWfId: 'wfA',
      workflows: {
        wfA: { name: 'A', nodes: [mkNode('n1')], edges: [] } as never,
        wfB: { name: 'B', nodes: [], edges: [] } as never,
      },
      projectName: '项目',
      projectId: 'pid',
      projectCreatedAt: '2026-01-01T00:00:00.000Z',
      subgraphs: {} as Record<string, never>,
      runHistory: [] as never[],
      artifacts: { handoffs: {}, received: {} },
      agentRouteTable: {} as Record<string, never>,
      pipelines: [] as never[],
    };

    it('是 buildProjectFile 的 JSON 字符串封装（可解析为合法 ProjectFile）', () => {
      const snap = projectSnapshot(base);
      expect(typeof snap).toBe('string');
      const parsed = JSON.parse(snap) as { kind: string; name: string; workflows: Record<string, unknown> };
      // 与 buildProjectFile 同输入产出的 ProjectFile 结构一致（仅 updatedAt/savedAt 时间戳逐次刷新，故比结构不比字节）
      const direct = buildProjectFile(base);
      expect(parsed.kind).toBe(direct.kind);
      expect(parsed.name).toBe(direct.name);
      expect(Object.keys(parsed.workflows)).toEqual(Object.keys(direct.workflows));
    });

    it('随落盘字段（如 nodes / runHistory）变化而改变（脏检测可用）', () => {
      const a = projectSnapshot(base);
      const moreNodes = projectSnapshot({ ...base, nodes: [mkNode('n1'), mkNode('n2')] });
      expect(moreNodes).not.toBe(a);

      // runHistory 经 buildProjectFile 写入 runs.history，属于落盘字段，会改变快照
      const withHistory = projectSnapshot({ ...base, runHistory: [{ id: 'x' }] as never });
      expect(withHistory).not.toBe(a);
    });
  });

  describe('DIRTY_KEYS', () => {
    it('覆盖核心落盘字段，且含运行态/日志白名单外的关键项', () => {
      const keys = DIRTY_KEYS as readonly string[];
      for (const k of ['nodes', 'edges', 'agents', 'groups', 'subgraphs', 'activeWfId', 'workflowName']) {
        expect(keys).toContain(k);
      }
      // 运行态/日志不该进白名单（避免频繁触发脏标记）
      expect(keys).not.toContain('running');
      expect(keys).not.toContain('logs');
    });
  });
});
