import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowNode } from '../types';
import { useWorkflowStore } from './workflowStore';

const node: FlowNode = {
  id: 'node-1',
  type: 'base',
  position: { x: 0, y: 0 },
  data: {
    typeId: 'input.text',
    label: '输入',
    params: {},
    status: 'idle',
  },
};

const invokeNewWorkflow = async (workspaceDir?: string | null): Promise<void> => {
  const action = useWorkflowStore.getState().newWorkflowInProject as unknown as (
    path?: string | null,
  ) => Promise<void>;
  await action(workspaceDir);
};

beforeEach(() => {
  useWorkflowStore.setState({
    projectId: 'project-1',
    activeWfId: '',
    workflowName: '未归属',
    nodes: [node],
    edges: [],
    workflows: {},
    agents: [],
    roles: [],
    variables: {},
    groups: [],
    projectPath: 'C:/projects/project-1',
    projectDirty: false,
    lastSavedSnapshot: null,
  } as never);
});

describe('workflowStore.newWorkflowInProject', () => {
  it('captures an unbound canvas before activating a fresh project workflow', async () => {
    await invokeNewWorkflow();

    const state = useWorkflowStore.getState();
    const captured = Object.values(state.workflows).find((workflow) => workflow.name === '未归属');
    const active = state.workflows[state.activeWfId];

    expect(captured?.nodes[0]?.id).toBe('node-1');
    expect(active?.name).toBe('工作流 2');
    expect(active?.belongsToProject).toBe('project-1');
    expect(active?.assets).toEqual([]);
    expect(state.nodes).toEqual([]);
  });

  it('preserves the explicit standalone workspace identity', async () => {
    useWorkflowStore.setState({
      projectId: null,
      activeWfId: '',
      nodes: [],
      projectPath: null,
    } as never);

    await invokeNewWorkflow('C:/workspace');

    const state = useWorkflowStore.getState();
    const active = state.workflows[state.activeWfId];
    expect(active?.workspaceDir).toBe('C:/workspace');
    expect(active?.standalonePath).toBe('C:/workspace');
    expect(active?.belongsToProject).toBeUndefined();
  });
});
