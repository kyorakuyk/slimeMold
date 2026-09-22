import { describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode } from '../types/graph';
import type { NodeGroup, SubgraphDef } from '../types/workflow';
import type { WorkflowGroupCommandState } from './workflowGroupCommands';
import { createWorkflowGroupCommands } from './workflowGroupCommands';

function createState(): WorkflowGroupCommandState {
  return {
    nodes: [{
      id: 'node-1',
      type: 'base',
      position: { x: 10, y: 20 },
      data: { typeId: 'test', label: 'Test', params: {}, status: 'idle' },
    } satisfies FlowNode],
    edges: [] as FlowEdge[],
    groups: [{
      id: 'group-1',
      title: 'Group',
      nodeIds: ['node-1'],
      color: '#000',
      collapsed: false,
    } satisfies NodeGroup],
    subgraphs: {} as Record<string, SubgraphDef>,
  };
}

function createCommands(state = createState()) {
  const setState = vi.fn((patch: Partial<WorkflowGroupCommandState> | ((state: WorkflowGroupCommandState) => Partial<WorkflowGroupCommandState>)) => {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  });
  return {
    state,
    setState,
    commands: createWorkflowGroupCommands({
      getState: () => state,
      setState,
      pushHistory: vi.fn(),
      addLog: vi.fn(),
      getFocusedSubgraphId: () => null,
      clearFocusedSubgraph: vi.fn(),
      getNodeDefinitions: () => ({}),
    }),
  };
}

describe('workflow group commands', () => {
  it('updates and moves a group through the command owner', () => {
    const { state, commands } = createCommands();

    commands.updateGroup('group-1', { title: 'Renamed' });
    commands.moveGroup('group-1', 5, -2);

    expect(state.groups[0].title).toBe('Renamed');
    expect(state.nodes[0].position).toEqual({ x: 15, y: 18 });
  });

  it('removes a group and its generated subgraph without touching the canvas store', () => {
    const state = createState();
    state.groups[0].subgraphId = 'sg-1';
    state.subgraphs['sg-1'] = {
      id: 'sg-1',
      name: 'Generated',
      category: 'group',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      nodes: [],
      edges: [],
      inputs: [],
      outputs: [],
    };
    const { state: next, commands } = createCommands(state);

    commands.removeGroup('group-1');

    expect(next.groups).toEqual([]);
    expect(next.subgraphs).toEqual({});
  });
});
