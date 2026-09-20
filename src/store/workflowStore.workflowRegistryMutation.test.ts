import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowFileInMemory } from '../types';
import { useWorkflowStore } from './workflowStore';

const workflow = (name: string): WorkflowFileInMemory => ({
  version: 1,
  name,
  savedAt: '2026-01-01',
  nodes: [],
  edges: [],
  agents: [],
  roles: [],
  workspaceDir: 'C:/explicit-workspace',
});

beforeEach(() => {
  useWorkflowStore.setState({
    activeWfId: 'wf-1',
    workflowName: 'WF1',
    workflows: { 'wf-1': workflow('WF1'), 'wf-2': workflow('WF2') },
    nodes: [],
    edges: [],
    selectedNodeId: null,
    logs: [],
  } as never);
});

describe('workflowStore workflow registry mutation facade', () => {
  it('renames the active workflow through the registry owner', () => {
    useWorkflowStore.getState().renameWorkflow('重命名');

    const state = useWorkflowStore.getState();
    expect(state.workflowName).toBe('重命名');
    expect(state.workflows['wf-1']?.name).toBe('重命名');
    expect(state.workflows['wf-2']?.name).toBe('WF2');
  });

  it('removes an inactive workflow without changing the active canvas', () => {
    useWorkflowStore.getState().removeWorkflow('wf-2');

    const state = useWorkflowStore.getState();
    expect(Object.keys(state.workflows)).toEqual(['wf-1']);
    expect(state.activeWfId).toBe('wf-1');
    expect(state.workflowName).toBe('WF1');
  });

  it('activates the first remaining workflow when removing the active one', () => {
    useWorkflowStore.getState().removeWorkflow('wf-1');

    const state = useWorkflowStore.getState();
    expect(state.activeWfId).toBe('wf-2');
    expect(state.workflowName).toBe('WF2');
    expect(state.nodes).toEqual([]);
  });

  it('preserves the empty registry behavior when removing the last workflow', () => {
    useWorkflowStore.setState({ workflows: { 'wf-1': workflow('WF1') } } as never);
    useWorkflowStore.getState().removeWorkflow('wf-1');

    const state = useWorkflowStore.getState();
    expect(state.workflows).toEqual({});
    expect(state.activeWfId).toBe('');
    expect(state.workflowName).toBe('');
    expect(state.nodes).toEqual([]);
  });
});
