import { describe, expect, it, vi } from 'vitest';
import type { NodeGroup, SubgraphDef } from '../types';
import type { WorkflowSubgraphCommandState } from './workflowSubgraphCommands';
import { createWorkflowSubgraphCommands } from './workflowSubgraphCommands';

function createState() {
  const state: WorkflowSubgraphCommandState = {
    nodes: [],
    edges: [],
    subgraphs: {
      'sg-1': {
        id: 'sg-1',
        name: 'Reusable',
        category: 'test',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        nodes: [],
        edges: [],
        inputs: [],
        outputs: [],
      } satisfies SubgraphDef,
    },
    groups: [] as NodeGroup[],
    selectedNodeId: null as string | null,
  };
  const setState = vi.fn((patch: Partial<WorkflowSubgraphCommandState>) => Object.assign(state, patch));
  const commands = createWorkflowSubgraphCommands({
    getState: () => state,
    setState,
    pushHistory: vi.fn(),
    addLog: vi.fn(),
  });
  return { state, setState, commands };
}

describe('workflow subgraph commands', () => {
  it('adds a reference node through the command owner', () => {
    const { state, commands } = createState();

    commands.addSubgraphRefNode('sg-1', { x: 24, y: 48 });

    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({
      type: 'base',
      position: { x: 24, y: 48 },
      data: {
        typeId: 'subgraph.ref',
        label: 'Reusable',
        params: { subgraphId: 'sg-1' },
        status: 'idle',
        dirty: true,
      },
    });
    expect(state.selectedNodeId).toBe(state.nodes[0].id);
  });

  it('removes a subgraph definition without owning React view state', () => {
    const { state, commands, setState } = createState();

    commands.removeSubgraph('sg-1');

    expect(setState).toHaveBeenCalledWith({ subgraphs: {} });
    expect(state.subgraphs).toEqual({});
  });
});
