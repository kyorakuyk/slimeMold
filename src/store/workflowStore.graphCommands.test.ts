import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowNode } from '../types';
import { useWorkflowStore } from './workflowStore';

const node = (id: string, selected = false): FlowNode => ({
  id,
  type: 'base',
  position: { x: 0, y: 0 },
  selected,
  data: { typeId: 'input.text', label: id, params: {}, status: 'idle' },
} as unknown as FlowNode);

beforeEach(() => {
  useWorkflowStore.setState({
    nodes: [node('before')],
    edges: [],
    past: [],
    future: [],
    clipboard: null,
    selectedNodeId: null,
    maxHistory: 10,
  } as never);
});

describe('workflowStore graph command assembly', () => {
  it('assembles injected graph commands and keeps selectAll in the facade', () => {
    const state = useWorkflowStore.getState();
    state.pushHistory();
    useWorkflowStore.setState({ nodes: [node('after')] } as never);

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes[0]?.id).toBe('before');

    useWorkflowStore.getState().selectAll();
    expect(useWorkflowStore.getState().nodes.every((item) => item.selected)).toBe(true);
  });
});
