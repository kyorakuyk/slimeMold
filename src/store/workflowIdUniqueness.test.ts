import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '../types';
import { useWorkflowStore } from './workflowStore';
import { createWorkflowId } from './workflowId';

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

describe('workflow id uniqueness inside one millisecond', () => {
  it('adds deterministic suffixes for IDs already taken at the same timestamp', () => {
    expect(createWorkflowId(1000)).toBe('wf-1000');
    expect(createWorkflowId(1000, ['wf-1000'])).toBe('wf-1000-2');
    expect(createWorkflowId(1000, ['wf-1000', 'wf-1000-2'])).toBe('wf-1000-3');
  });

  it('does not reuse the active workflow id when a second workflow is created', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await invokeNewWorkflow();
      const afterFirst = useWorkflowStore.getState();
      const firstCreatedId = afterFirst.activeWfId;
      const capturedId = Object.keys(afterFirst.workflows).find((id) => id !== firstCreatedId);

      expect(capturedId).toBeDefined();
      expect(capturedId).not.toBe(firstCreatedId);

      await invokeNewWorkflow();
      const afterSecond = useWorkflowStore.getState();
      const ids = Object.keys(afterSecond.workflows);

      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(afterSecond.activeWfId).not.toBe(firstCreatedId);
      expect(new Set(Object.values(afterSecond.workflows).map((wf) => wf.name)).size).toBe(3);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps the captured canvas workflow distinct from the newly created workflow', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await invokeNewWorkflow();
    } finally {
      now.mockRestore();
    }

    const state = useWorkflowStore.getState();
    const ids = Object.keys(state.workflows);
    const captured = state.workflows[ids[0]];

    expect(ids).toHaveLength(2);
    expect(state.activeWfId).not.toBe(ids[0]);
    expect(captured?.nodes[0]?.id).toBe('node-1');
    expect(state.workflows[state.activeWfId]?.nodes).toHaveLength(0);
  });
});
