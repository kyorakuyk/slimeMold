import { describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode } from '../types';
import { createWorkflowGraphCommands, type GraphCommandState } from './workflowGraphCommands';

const node = (id: string, selected = false): FlowNode => ({
  id,
  type: 'base',
  position: { x: 0, y: 0 },
  selected,
  data: { typeId: 'input.text', label: id, params: {}, status: 'running', error: 'old' },
} as unknown as FlowNode);

const edge = (id: string, source: string, target: string): FlowEdge => ({
  id, source, target, data: {},
} as unknown as FlowEdge);

const makeHarness = (initial: Partial<GraphCommandState> = {}) => {
  const state = {
    nodes: [],
    edges: [],
    past: [],
    future: [],
    maxHistory: 10,
    clipboard: null,
    selectedNodeId: null,
    ...initial,
  } as GraphCommandState;
  const addLog = vi.fn();
  const commands = createWorkflowGraphCommands({
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    addLog,
  });
  return { state, commands, addLog };
};

describe('workflowGraphCommands', () => {
  it('round-trips history through undo and redo', () => {
    const { state, commands } = makeHarness({ nodes: [node('before')] });
    commands.pushHistory();
    state.nodes = [node('after')];

    commands.undo();
    expect(state.nodes[0]?.id).toBe('before');
    commands.redo();
    expect(state.nodes[0]?.id).toBe('after');
  });

  it('copies selected nodes, only internal edges, and emits the existing log', () => {
    const { state, commands, addLog } = makeHarness({
      nodes: [node('a', true), node('b', true), node('c')],
      edges: [edge('internal', 'a', 'b'), edge('external', 'a', 'c')],
    });
    commands.copySelection();

    expect(state.clipboard?.nodes.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.clipboard?.edges.map((item) => item.id)).toEqual(['internal']);
    expect(state.clipboard?.nodes[0]?.data.status).toBe('idle');
    expect(addLog).toHaveBeenCalledWith('info', '已复制 2 个节点到剪贴板');
  });

  it('pastes remapped nodes, offsets them, and selects the first pasted node', () => {
    const { state, commands } = makeHarness({
      clipboard: { nodes: [node('a'), node('b')], edges: [edge('e', 'a', 'b')] },
      nodes: [node('existing')],
      edges: [],
    });
    commands.pasteClipboard();

    expect(state.nodes).toHaveLength(3);
    expect(state.nodes.slice(1).every((item) => item.selected)).toBe(true);
    expect(state.edges).toHaveLength(1);
    expect(state.selectedNodeId).toBe(state.nodes[1]?.id);
    expect(state.past).toHaveLength(1);
  });
});
