import { act } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@xyflow/react';
import type { FlowEdge, FlowNode } from '../types/graph';
import type { NodeDefinition } from '../types/node';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import useCanvasReconnect from './useCanvasReconnect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reconnect = (oldEdge: FlowEdge, connection: Connection) => void;

function ReconnectProbe({
  nodes,
  isSplit,
  setSplitEdges,
  capture,
}: {
  nodes: FlowNode[];
  isSplit: boolean;
  setSplitEdges: Dispatch<SetStateAction<FlowEdge[]>>;
  capture: { current: Reconnect | null };
}) {
  capture.current = useCanvasReconnect({
    isSplit,
    nodes,
    setSplitEdges,
    t: ((key: string) => key) as never,
  });
  return null;
}

function makeNode(id: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'test.reconnect', label: id, params: {}, status: 'idle' },
  } as unknown as FlowNode;
}

const reconnectDefinition: NodeDefinition = {
  typeId: 'test.reconnect',
  name: 'Reconnect test node',
  category: 'test',
  inputs: [{ id: 'in', label: 'Input', type: 'string' }],
  outputs: [{ id: 'out', label: 'Output', type: 'string' }],
  params: [],
  execute: async () => ({}),
};

function makeEdge(id: string, source: string, target: string): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data' },
  } as FlowEdge;
}

describe('canvas reconnect contracts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useRegistryStore.setState({ defs: { 'test.reconnect': reconnectDefinition } });
    useWorkflowStore.setState({
      projectId: 'reconnect-test-project',
      activeWfId: 'wf-main',
      workflowName: 'Main',
      nodes: [],
      edges: [],
      workflows: {},
      subgraphs: {},
      logs: [],
      projectDirty: false,
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    useRegistryStore.setState({ defs: {} });
    useWorkflowStore.setState({ edges: [], logs: [], projectDirty: false } as never);
  });

  it('orders main-canvas reconnect as history, edge mutation, then dirty mark', async () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const oldEdge = makeEdge('old-edge', 'A', 'B');
    useWorkflowStore.setState({ nodes, edges: [oldEdge] } as never);
    const order: string[] = [];
    const state = useWorkflowStore.getState();
    const pushHistory = state.pushHistory;
    const markDirty = state.markDirty;
    vi.spyOn(state, 'pushHistory').mockImplementation(() => {
      order.push('pushHistory');
      pushHistory();
    });
    vi.spyOn(state, 'markDirty').mockImplementation((nodeId) => {
      order.push('markDirty');
      markDirty(nodeId);
    });
    const originalSetState = useWorkflowStore.setState;
    vi.spyOn(useWorkflowStore, 'setState').mockImplementation((partial, replace) => {
      if (typeof partial === 'object' && partial !== null && 'edges' in partial) order.push('edges');
      return originalSetState(partial, replace);
    });
    const capture = { current: null as Reconnect | null };
    await act(async () => {
      root.render(
        <ReconnectProbe
          nodes={nodes}
          isSplit={false}
          setSplitEdges={vi.fn() as never}
          capture={capture}
        />,
      );
    });

    act(() => capture.current?.(oldEdge, {
      source: 'A', sourceHandle: 'out', target: 'C', targetHandle: 'in',
    }));

    expect(order).toEqual(['pushHistory', 'edges', 'markDirty']);
    expect(useWorkflowStore.getState().edges[0]).toMatchObject({ id: 'old-edge', target: 'C' });
    expect(useWorkflowStore.getState().projectDirty).toBe(true);
  });

  it('checks split reconnect cycles against primary store edges', async () => {
    const nodes = ['A', 'B', 'C', 'D'].map(makeNode);
    const mainEdges = [makeEdge('A-B', 'A', 'B'), makeEdge('B-C', 'B', 'C')];
    const splitOldEdge = makeEdge('split-old', 'C', 'D');
    useWorkflowStore.setState({ edges: mainEdges } as never);
    const setSplitEdges = vi.fn();
    const capture = { current: null as Reconnect | null };
    await act(async () => {
      root.render(
        <ReconnectProbe
          nodes={nodes}
          isSplit
          setSplitEdges={setSplitEdges as never}
          capture={capture}
        />,
      );
    });

    act(() => capture.current?.(splitOldEdge, {
      source: 'C', sourceHandle: 'out', target: 'A', targetHandle: 'in',
    }));

    expect(setSplitEdges).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().edges).toEqual(mainEdges);
    expect(useWorkflowStore.getState().logs.at(-1)?.message).toBe('canvas.reconnect.cycleCancelled');
  });
});
