import { describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode, WorkflowFile } from '../types';
import { createWorkflowRegistryActions, type WorkflowRegistryActionState } from './workflowRegistryActions';

const node = (id: string): FlowNode => ({
  id,
  type: 'base',
  position: { x: 0, y: 0 },
  data: { typeId: 'input.text', label: id, params: {}, status: 'idle' },
} as unknown as FlowNode);

const workflow = (name: string): WorkflowFile => ({
  version: 1, name, savedAt: '2026-01-01', nodes: [], edges: [], agents: [], roles: [],
});

const harness = (initial: Partial<WorkflowRegistryActionState> = {}) => {
  const state = {
    workflows: {}, activeWfId: '', workflowName: '', nodes: [], edges: [], agents: [], roles: [],
    variables: {}, groups: [], defaultAgentId: null, projectId: 'p1', selectedNodeId: null, logs: [],
    ...initial,
  } as WorkflowRegistryActionState;
  const setSuppressed = vi.fn();
  const resolveStandalonePath = vi.fn(async (path?: string | null) => path ?? 'C:/default');
  const actions = createWorkflowRegistryActions({
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    setDirtySuppressed: setSuppressed,
    resolveStandalonePath,
    now: () => 1000,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    createRegisteredWorkflowId: () => 'wf-registered',
  });
  return { state, actions, setSuppressed, resolveStandalonePath };
};

describe('workflowRegistryActions', () => {
  it('switches with dirty suppression and preserves the public transition', () => {
    const { state, actions, setSuppressed } = harness({
      activeWfId: 'wf-1', workflowName: 'WF1',
      workflows: {
        'wf-1': { name: 'WF1', nodes: [node('a')], edges: [], agents: [], roles: [] },
        'wf-2': { name: 'WF2', nodes: [node('b')], edges: [], agents: [], roles: [] },
      } as never,
      nodes: [node('a')], edges: [] as FlowEdge[],
    });
    actions.switchWorkflow('wf-2');
    expect(state.activeWfId).toBe('wf-2');
    expect(state.nodes[0]?.id).toBe('b');
    expect(setSuppressed.mock.calls).toEqual([[true], [false]]);
  });

  it('injects project/standalone path and preserves capture clock ordering', async () => {
    const state = harness({
      projectId: null, activeWfId: '', workflowName: '未归属', nodes: [node('a')],
    });
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const nowIso = vi.fn()
      .mockReturnValueOnce('capture-time')
      .mockReturnValueOnce('new-time');
    const resolveStandalonePath = vi.fn(async () => 'C:/default');
    const actions = createWorkflowRegistryActions({
      getState: () => state.state,
      setState: (patch) => Object.assign(state.state, patch),
      setDirtySuppressed: state.setSuppressed,
      resolveStandalonePath,
      now,
      nowIso,
      createRegisteredWorkflowId: () => 'unused',
    });
    await actions.newWorkflowInProject();
    expect(resolveStandalonePath).toHaveBeenCalledOnce();
    expect(state.state.workflows['wf-1000']?.savedAt).toBe('capture-time');
    expect(state.state.activeWfId).toBe('wf-2001');
    expect(state.state.workflows['wf-2001']?.savedAt).toBe('new-time');
  });

  it('registers without activation and returns the generated id', () => {
    const { state, actions } = harness({ activeWfId: 'wf-active' });
    const id = actions.registerWorkflow(workflow('Registered'), { activate: false });
    expect(id).toBe('wf-registered');
    expect(state.workflows['wf-registered']?.name).toBe('Registered');
    expect(state.activeWfId).toBe('wf-active');
  });
});
