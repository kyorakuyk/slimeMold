import { describe, expect, it } from 'vitest';
import './workflow';
import type {
  NodeGroup,
  SubgraphDef,
  WorkflowFile,
  WorkflowFileInMemory,
} from './workflow';

describe('workflow file contract owner', () => {
  it('keeps workflow, subgraph, and group contracts composable', () => {
    const group: NodeGroup = {
      id: 'group-1',
      title: 'Group',
      nodeIds: ['node-1'],
      color: '#000',
      collapsed: false,
    };
    const subgraph: SubgraphDef = {
      id: 'subgraph-1',
      name: 'Subgraph',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      nodes: [],
      edges: [],
      inputs: [],
      outputs: [],
    };
    const workflow: WorkflowFile = {
      version: 1,
      name: 'Workflow',
      savedAt: '2026-01-01T00:00:00.000Z',
      nodes: [],
      edges: [],
      agents: [],
      groups: [group],
    };
    const inMemory: WorkflowFileInMemory = {
      ...workflow,
      nodes: [],
      edges: [],
    };

    expect(inMemory.groups?.[0]).toEqual(group);
    expect(subgraph.inputs).toEqual([]);
    expect(subgraph.outputs).toEqual([]);
  });
});
