/**
 * workflowState.test.ts — G5 门面化：状态转换纯逻辑单测。
 *
 * 覆盖：upsertById（按 id 更新/追加）、cleanupRouteTableForAgent（删除 agent 后路由表清理）、
 * buildOpenProjectState（项目装载状态构建）、buildSwitchWorkflowState（工作流切换状态构建）。
 */
import { describe, it, expect } from 'vitest';
import type { AgentRouteTable, AssetMeta, FlowEdge, FlowNode, ProjectFile, WorkflowFile, WorkflowFileInMemory } from '../types';
import {
  buildCreateProjectState,
  buildNewProjectState,
  buildRegisteredWorkflowState,
  buildNewWorkflowInProjectState,
  buildOpenProjectState,
  buildSwitchWorkflowState,
  cleanupRouteTableForAgent,
  resolveActiveWorkflowWorkspaceDir,
  upsertById,
} from './workflowState';

const mkFlowNode = (id: string, typeId: string): FlowNode =>
  ({ id, type: 'base', position: { x: 0, y: 0 }, data: { typeId, label: id, params: {}, status: 'idle' } }) as unknown as FlowNode;

const mkWf = (name: string): WorkflowFile =>
  ({
    version: 1,
    name,
    savedAt: '',
    nodes: [{ id: 'a', typeId: 'input.text', label: 'A', position: { x: 0, y: 0 }, params: {} }],
    edges: [],
    agents: [],
    roles: [],
  }) as unknown as WorkflowFile;

const mkProject = (): ProjectFile =>
  ({
    version: 1,
    kind: 'project',
    id: 'p1',
    name: '项目',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    activeId: 'wf1',
    workflows: { wf1: mkWf('工作流1') },
  }) as unknown as ProjectFile;

describe('resolveActiveWorkflowWorkspaceDir', () => {
  it('uses the active workflow workspace before the legacy top-level fallback', () => {
    expect(resolveActiveWorkflowWorkspaceDir({
      activeWfId: 'wf-1',
      workflows: { 'wf-1': { workspaceDir: 'C:/workspace/wf-1' } },
      workspaceDir: null,
    })).toBe('C:/workspace/wf-1');
  });

  it('falls back to the top-level field for legacy workflows without workspaceDir', () => {
    expect(resolveActiveWorkflowWorkspaceDir({
      activeWfId: 'wf-1',
      workflows: { 'wf-1': {} },
      workspaceDir: 'C:/workspace/legacy',
    })).toBe('C:/workspace/legacy');
  });
});

describe('upsertById 通用 upsert', () => {
  it('追加新项', () => {
    expect(upsertById([{ id: 'a' }], { id: 'b' })).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('替换同 id 项', () => {
    expect(upsertById([{ id: 'a', v: 1 }, { id: 'b' }], { id: 'a', v: 2 })).toEqual([
      { id: 'a', v: 2 },
      { id: 'b' },
    ]);
  });

  it('不改变原数组', () => {
    const orig = [{ id: 'a' }];
    upsertById(orig, { id: 'b' });
    expect(orig).toHaveLength(1); // 原数组不变
  });
});

describe('cleanupRouteTableForAgent 路由表清理', () => {
  it('agentId 命中且无 fallback → 整体移除该类别项并标记变更', () => {
    const table: AgentRouteTable = { ui: { agentId: 'agentA' } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.ui).toBeUndefined(); // agentId 置空后无 fallback → 整体移除
  });

  it('agentId 命中但有 fallback → 保留该项、agentId 置空', () => {
    const table: AgentRouteTable = { ui: { agentId: 'agentA', fallback: ['b'] } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.ui?.agentId).toBe('');
    expect(t.ui?.fallback).toEqual(['b']);
  });

  it('fallback 命中 → 从数组剔除', () => {
    const table: AgentRouteTable = { logic: { agentId: 'x', fallback: ['agentB', 'agentA'] } };
    const { table: t } = cleanupRouteTableForAgent(table, 'agentA');
    expect(t.logic?.fallback).toEqual(['agentB']);
  });

  it('无任何引用 → 整体移除该类别项', () => {
    const table: AgentRouteTable = { docs: { agentId: 'agentA', fallback: [] } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.docs).toBeUndefined();
  });

  it('未引用该 agent → 不变更', () => {
    const table: AgentRouteTable = { ui: { agentId: 'other' } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(false);
    expect(t.ui?.agentId).toBe('other');
    expect(Object.keys(t)).toEqual(['ui']);
  });
});

describe('buildOpenProjectState 项目装载状态构建', () => {
  it('基础字段：项目元信息 + 激活工作流还原到画布', () => {
    const st = buildOpenProjectState(mkProject(), '/path/p1', null);
    expect(st.projectName).toBe('项目');
    expect(st.projectId).toBe('p1');
    expect(st.projectPath).toBe('/path/p1');
    expect(st.activeWfId).toBe('wf1');
    expect(st.workflowName).toBe('工作流1');
    // 工作流还原到画布（nodes/edges）
    expect(st.nodes).toHaveLength(1);
    expect(st.edges).toHaveLength(0);
    expect(st.selectedNodeId).toBeNull();
  });

  it('恢复项目级 orchestrations，保留阶段日志和绑定关系', () => {
    const orchestration = {
      id: 'orch-1',
      goal: '完成项目',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      draft: { stages: [], edges: [] },
      stageLogs: [{ stageId: 'plan', status: 'failed', wfId: 'wf1', runId: 7 }],
      stageWfIds: { plan: 'wf1' },
      runIds: [7],
    };
    const project = {
      ...mkProject(),
      orchestrations: [orchestration],
      projectControl: {
        version: 1,
        activeSessionId: null,
        masterAgentId: null,
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
      },
    } as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null) as unknown as typeof project & {
      orchestrations?: unknown[];
      projectControl?: unknown;
    };
    expect(st.orchestrations).toEqual([orchestration]);
    expect(st.projectControl).toEqual(project.projectControl);
  });

  it('恢复项目级 workerRuns，保留 queued 状态供继续执行', () => {
    const workerRun = {
      version: 1,
      projectId: 'p1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'queued',
          attempt: 0,
          evidenceIds: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const project = { ...mkProject(), workerRuns: [workerRun] } as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null);
    expect(st.workerRuns).toEqual([workerRun]);
  });

  it('workerRuns 损坏时安全降级为空 registry', () => {
    const project = { ...mkProject(), workerRuns: 'damaged' } as unknown as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null);
    expect(st.workerRuns).toEqual([]);
  });

  it('新建项目初始化空的项目控制面快照', () => {
    const st = buildNewProjectState('新项目') as unknown as { projectControl?: unknown };
    expect(st.projectControl).toEqual({
      version: 1,
      activeSessionId: null,
      masterAgentId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });
  });

  it('agents 项目级优先，缺省回退工作流级，再回退默认 ollama', () => {
    const p = mkProject();
    p.agents = [{ id: 'proj-agent' } as never];
    const st = buildOpenProjectState(p, '/p', null);
    expect(st.agents).toHaveLength(1);
    expect(st.agents[0].id).toBe('proj-agent');
  });

  it('无可用工作流 → 抛错', () => {
    const p = mkProject();
    p.activeId = 'ghost';
    p.workflows = {};
    expect(() => buildOpenProjectState(p, '/p', null)).toThrow();
  });

  it('损坏的项目控制面快照安全降级为空快照', () => {
    const project = {
      ...mkProject(),
      projectControl: { version: 1, sessions: 'bad', decisions: [], briefs: [] },
    } as unknown as ProjectFile;
    const st = buildOpenProjectState(project, '/p', null);

    expect(st.projectControl).toEqual({
      version: 1,
      activeSessionId: null,
      masterAgentId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });
  });
});

describe('buildSwitchWorkflowState 工作流切换状态构建', () => {
  const baseView = {
    workflows: {
      wf1: { name: 'WF1', nodes: [mkFlowNode('a', 'input.text')], edges: [] as FlowEdge[], agents: [], roles: [] },
      wf2: { name: 'WF2', nodes: [mkFlowNode('b', 'output.text')], edges: [] as FlowEdge[], agents: [], roles: [] },
    } as never,
    activeWfId: 'wf1',
    workflowName: 'WF1',
    nodes: [mkFlowNode('a', 'input.text')],
    edges: [] as FlowEdge[],
    agents: [],
    roles: [],
    variables: {},
  };

  it('切到目标工作流：加载其节点/名称，agents 保持当前', () => {
    const st = buildSwitchWorkflowState(baseView, 'wf2');
    expect(st).not.toBeNull();
    expect(st!.activeWfId).toBe('wf2');
    expect(st!.workflowName).toBe('WF2');
    expect(st!.nodes).toHaveLength(1);
    expect(st!.nodes[0].id).toBe('b');
  });

  it('切到当前工作流 → 返回 null', () => {
    expect(buildSwitchWorkflowState(baseView, 'wf1')).toBeNull();
  });

  it('目标不存在 → 返回 null', () => {
    expect(buildSwitchWorkflowState(baseView, 'ghost')).toBeNull();
  });
});

describe('buildNewProjectState 新建项目状态构建', () => {
  it('生成项目元信息 + 一个空白工作流', () => {
    const st = buildNewProjectState('新项目');
    expect(st.projectName).toBe('新项目');
    expect(st.projectId).toMatch(/^proj-/);
    expect(st.projectPath).toBeNull();
    expect(st.projectDirty).toBe(true); // 尚未落盘
    expect(st.lastSavedSnapshot).toBeNull();
    expect(Object.keys(st.workflows)).toHaveLength(1);
    const wfId = Object.keys(st.workflows)[0];
    expect(st.activeWfId).toBe(wfId);
    expect(st.workflowName).toBe('未命名工作流');
    expect(st.nodes).toHaveLength(0);
    expect(st.edges).toHaveLength(0);
    expect(st.selectedNodeId).toBeNull();
  });

  it('空白工作流带默认 ollama agent 和内置角色', () => {
    const st = buildNewProjectState('x');
    const wf = st.workflows[st.activeWfId];
    expect(wf.agents[0]?.protocol).toBe('ollama');
    expect(st.agents[0]?.protocol).toBe('ollama');
    expect(st.roles.length).toBeGreaterThan(0);
  });
});

describe('buildRegisteredWorkflowState 工作流注册状态构建', () => {
  it('activate=false 只注册 normalized workflow，不生成画布 activation', () => {
    const result = buildRegisteredWorkflowState({
      workflow: mkWf('注册工作流'),
      id: 'wf-registered',
      savedAt: '2026-09-20T00:00:00.000Z',
      projectId: 'project-1',
      workflows: {},
      activeWfId: '',
      activate: false,
    });

    expect(result.workflows['wf-registered']?.name).toBe('注册工作流');
    expect(result.activation).toBeUndefined();
  });

  it('activate=true reuses normalized workflow for dirty canvas activation', () => {
    const result = buildRegisteredWorkflowState({
      workflow: mkWf('注册工作流'),
      id: 'wf-registered',
      savedAt: '2026-09-20T00:00:00.000Z',
      projectId: 'project-1',
      workflows: {},
      activeWfId: '',
      activate: true,
      name: '覆盖名称',
    });

    expect(result.activation?.activeWfId).toBe('wf-registered');
    expect(result.activation?.workflowName).toBe('覆盖名称');
    expect(result.activation?.nodes[0]?.data.dirty).toBe(true);
    expect(result.activation?.edges).toEqual([]);
  });
});

describe('buildCreateProjectState 创建项目状态构建', () => {
  it('keeps template graph and project metadata consistent', () => {
    const node = mkFlowNode('node-1', 'input.text');
    const edges: FlowEdge[] = [];
    const st = buildCreateProjectState({
      name: 'Starter Project',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      createdAt: '2026-09-20T00:00:00.000Z',
      projectPath: 'C:/projects/starter',
      template: { name: 'Starter', nodes: [node], edges },
    });

    expect(st.projectName).toBe('Starter Project');
    expect(st.projectId).toBe('project-1');
    expect(st.projectPath).toBe('C:/projects/starter');
    expect(st.projectDirty).toBe(true);
    expect(st.activeWfId).toBe('workflow-1');
    expect(st.workflowName).toBe('Starter');
    expect(st.nodes[0]?.id).toBe('node-1');
    expect(st.nodes[0]?.data.dirty).toBe(true);
    expect(st.roles).not.toBe(st.workflows['workflow-1']?.roles);
    expect(st.roles[0]).not.toBe(st.workflows['workflow-1']?.roles?.[0]);
    expect(st.edges).toEqual(edges);
    expect(st.workerRuns).toEqual([]);
  });
});

describe('buildNewWorkflowInProjectState', () => {
  it('builds project and standalone registry activation state', () => {
    const current = {
      workflowName: '未归属',
      nodes: [mkFlowNode('node-1', 'input.text')],
      edges: [],
      agents: [],
      roles: [],
      variables: {},
      groups: [],
    };
    const project = buildNewWorkflowInProjectState({
      workflows: {}, activeWfId: '', current, projectId: 'p1', workflowId: 'wf1',
      capturedWorkflowId: 'wf-captured', capturedSavedAt: '2026-01-01T00:00:00.500Z', savedAt: '2026-01-01',
    });
    expect(project.workflows['wf-captured']?.nodes[0]?.id).toBe('node-1');
    expect(project.workflows['wf-captured']?.savedAt).toBe('2026-01-01T00:00:00.500Z');
    expect(project.workflows.wf1?.belongsToProject).toBe('p1');
    expect(project.workflows.wf1?.assets).toEqual([]);
    expect(project.activation?.workflowName).toBe('工作流 2');

    const standalone = buildNewWorkflowInProjectState({
      workflows: {}, activeWfId: '', current: { ...current, nodes: [], edges: [] }, projectId: null,
      standalonePath: 'C:/workspace', workflowId: 'wf2', capturedWorkflowId: 'wf-captured-2', capturedSavedAt: '2026-01-01T00:00:01.000Z', savedAt: '2026-01-01',
    });
    expect(standalone.workflows.wf2?.workspaceDir).toBe('C:/workspace');
    expect(standalone.workflows.wf2?.standalonePath).toBe('C:/workspace');
  });

  it('preserves captured assets without mutating the source registry', () => {
    const assets: AssetMeta[] = [{
      id: 'asset-1', name: 'note.txt', path: null, kind: 'text', content: 'x',
      createdAt: '2026-01-01', inWorkspace: false,
    }];
    const captured = {
      version: 1, name: '旧游离工作流', savedAt: 'old', nodes: [], edges: [], agents: [], roles: [], assets,
    } as unknown as WorkflowFileInMemory;
    const workflows = { 'wf-captured': captured };

    const result = buildNewWorkflowInProjectState({
      workflows, activeWfId: '', current: {
        workflowName: '未归属', nodes: [mkFlowNode('node-1', 'input.text')], edges: [],
        agents: [], roles: [], variables: {}, groups: [],
      }, projectId: null, standalonePath: 'C:/workspace', workflowId: 'wf-new',
      capturedWorkflowId: 'wf-captured', capturedSavedAt: '2026-01-01T00:00:00.500Z', savedAt: '2026-01-01',
    });

    expect(result.workflows['wf-captured']?.assets).toBe(assets);
    expect(workflows['wf-captured']).toBe(captured);
    expect(workflows['wf-captured']?.savedAt).toBe('old');
  });
});
