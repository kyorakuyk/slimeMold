/**
 * workflowState.test.ts — G5 门面化：状态转换纯逻辑单测。
 *
 * 覆盖：upsertById（按 id 更新/追加）、cleanupRouteTableForAgent（删除 agent 后路由表清理）、
 * buildOpenProjectState（项目装载状态构建）、buildSwitchWorkflowState（工作流切换状态构建）。
 */
import { describe, it, expect } from 'vitest';
import type { AgentRouteTable, FlowEdge, FlowNode, ProjectFile, WorkflowFile } from '../types';
import {
  buildOpenProjectState,
  buildSwitchWorkflowState,
  cleanupRouteTableForAgent,
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
