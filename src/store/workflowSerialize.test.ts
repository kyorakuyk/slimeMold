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

/** 顶层共享的项目输入样例（供 projectSnapshot / DIRTY_KEYS 测试复用） */
const baseProject = {
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

    it('把项目级 orchestrations 写入 ProjectFile 并纳入稳定快照', () => {
      const orchestration = {
        id: 'orch-1',
        goal: '完成项目',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        draft: { stages: [], edges: [] },
        stageLogs: [],
        runIds: [],
      };
      const input = { ...baseProject, orchestrations: [orchestration] } as never;
      const pf = buildProjectFile(input) as unknown as { orchestrations?: unknown[] };
      expect(pf.orchestrations).toEqual([orchestration]);

      const snapshot = JSON.parse(projectSnapshot(input)) as { orchestrations?: unknown[] };
      expect(snapshot.orchestrations).toEqual([orchestration]);
    });

    it('把项目级 workerRuns 写入 ProjectFile 并纳入稳定快照', () => {
      const workerRun = {
        version: 1,
        projectId: 'pid',
        runId: 'run-1',
        orchestrationId: 'orch-1',
        taskGraphId: 'graph-1',
        taskGraphVersion: 2,
        status: 'succeeded',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tasks: {
          'task-1': {
            taskId: 'task-1',
            status: 'succeeded',
            attempt: 1,
            worktreeId: 'wt-1',
            worktreePath: 'C:/project-workers/run-1/task-1',
            branch: 'worker/task-1',
            baseRevision: 'abc123',
            evidenceIds: ['ev-1'],
            acceptanceId: 'acc-1',
            cleanupStatus: 'cleaned',
            cleanupReceiptId: 'cleanup-receipt-1',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      const input = { ...baseProject, workerRuns: [workerRun] } as never;
      const pf = buildProjectFile(input) as unknown as { workerRuns?: unknown[] };
      expect(pf.workerRuns).toEqual([workerRun]);

      const snapshot = JSON.parse(projectSnapshot(input)) as { workerRuns?: unknown[] };
      expect(snapshot.workerRuns).toEqual([workerRun]);
    });

    it('把项目控制面快照写入 ProjectFile', () => {
      const control = {
        version: 1,
        activeSessionId: 'session-1',
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
      };
      const pf = buildProjectFile({ ...baseProject, projectControl: control } as never) as unknown as {
        projectControl?: unknown;
      };
      expect(pf.projectControl).toEqual(control);
    });
  });

  describe('projectSnapshot', () => {
    const base = baseProject;

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

    it('同一内容多次快照产出相同字节（时间戳/自增 id 不污染快照）', () => {
      // P1 回归：此前 buildProjectFile 每次刷新 updatedAt/savedAt，导致
      // projectSnapshot 逐次不同 → dirty 检测恒为 true（永远显示未保存）。
      const a = projectSnapshot(base);
      const b = projectSnapshot(base);
      const c = projectSnapshot({ ...base, projectId: 'pid' }); // 已指定 id，不应 fallback 到 Date.now()
      expect(b).toBe(a);
      expect(c).toBe(a);

      // 未指定 projectId 的游离态：稳定模式用确定性占位，也不逐次变化
      const freeBase = { ...base, projectId: null, projectCreatedAt: null };
      const f1 = projectSnapshot(freeBase);
      const f2 = projectSnapshot(freeBase);
      expect(f2).toBe(f1);
    });
  });

  describe('DIRTY_KEYS', () => {
    const base = baseProject;

    it('覆盖核心落盘字段，且不含视图态/运行配置/运行态', () => {
      const keys = DIRTY_KEYS as readonly string[];
      for (const k of ['nodes', 'edges', 'agents', 'groups', 'subgraphs', 'workflowName', 'projectVariables', 'projectControl']) {
        expect(keys).toContain(k);
      }
      // 视图态/运行配置/运行态不该进白名单：
      // - activeWfId：切换激活工作流是视图态，且 projectSnapshot 稳定模式已排除 activeId
      // - llmChannel/failFast/skipFailed/maxConcurrency：不落盘的运行配置
      // - running/logs：运行态，触发脏标记会误报
      for (const k of ['activeWfId', 'llmChannel', 'failFast', 'skipFailed', 'maxConcurrency', 'running', 'logs']) {
        expect(keys).not.toContain(k);
      }
    });

    it('稳定快照的 activeId 被置空（保存落盘时仍保留真实值）', () => {
      // DIRTY_KEYS 已不含 activeWfId（见上一用例），切换工作流不会触发脏比对误报；
      // 此处验证稳定快照进一步把 activeId 置空，从字节层排除视图态。
      expect(JSON.parse(projectSnapshot(base) as string).activeId).toBe('');
      // 保存路径（stable=false）保留真实 activeId
      expect(buildProjectFile(base).activeId).toBe('wfA');
    });
  });
});
