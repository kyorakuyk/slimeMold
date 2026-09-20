/** workflowRegistryState direct tests. */
import { describe, it, expect } from 'vitest';
import type { AssetMeta, FlowEdge, FlowNode, WorkflowFile, WorkflowFileInMemory } from '../types';
import {
  buildNewWorkflowInProjectState,
  buildRegisteredWorkflowState,
  buildSwitchWorkflowState,
  resolveActiveWorkflowWorkspaceDir,
} from './workflowRegistryState';

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
