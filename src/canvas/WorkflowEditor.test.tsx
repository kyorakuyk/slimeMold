import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const canvasHarness = vi.hoisted(() => ({
  storeApis: [] as unknown[],
  reactFlowProps: [] as Array<Record<string, unknown>>,
  useRealReactFlow: false,
  runWorkflow: vi.fn(),
  stopWorkflow: vi.fn(),
}));

vi.mock('@xyflow/react', async (importActual) => {
  const actual = await importActual<typeof import('@xyflow/react')>();
  const React = await import('react');
  const RealReactFlow = actual.ReactFlow as unknown as ComponentType<
    Record<string, unknown> & { children?: ReactNode }
  >;
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
      canvasHarness.storeApis.push(actual.useStoreApi());
      canvasHarness.reactFlowProps.push(props);
      if (canvasHarness.useRealReactFlow) return React.createElement(RealReactFlow, props);
      return React.createElement('div', { 'data-testid': 'workflow-editor-flow' }, props.children);
    },
    Panel: ({ children }: { children?: ReactNode }) =>
      React.createElement('div', { 'data-testid': 'workflow-editor-panel' }, children),
    Background: () => null,
    MiniMap: () => null,
  };
});

vi.mock('../engine/executor', () => ({
  runWorkflow: canvasHarness.runWorkflow,
  stopWorkflow: canvasHarness.stopWorkflow,
}));

vi.mock('../components/GroupLayer', () => ({ default: () => null }));
vi.mock('../components/JobBoard', () => ({ default: () => null }));
vi.mock('../components/Companion', () => ({ default: () => null }));
vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

import { ReactFlowProvider, useStoreApi, type Connection, type OnEdgesChange, type OnNodesChange } from '@xyflow/react';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';
import type { FlowEdge, FlowNode } from '../types/graph';
import type { WorkflowFileInMemory } from '../types/workflow';
import WorkflowEditor, { DND_MIME } from './WorkflowEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function StoreApiProbe({ capture }: { capture: { current: unknown } }) {
  capture.current = useStoreApi();
  return null;
}

function resetCanvasStore() {
  localStorage.removeItem('slime-mold-workflow');
  localStorage.removeItem('sm.lastSession');
  act(() => useWorkflowStore.getState().closeProject());
  useWorkflowStore.setState({
    projectId: 'workflow-editor-test-project',
    projectName: 'WorkflowEditor test project',
    projectCreatedAt: null,
    projectPath: null,
    projectDirty: false,
    lastSavedSnapshot: null,
    workflows: {},
    activeWfId: '',
    workflowName: '',
    nodes: [],
    edges: [],
    groups: [],
    subgraphs: {},
    selectedNodeId: null,
    selectedIds: [],
    focusWfId: '',
  });
}

function seedSplitWorkflows(nodeA: FlowNode, nodeB: FlowNode) {
  const wfA = 'workflow-editor-split-a';
  const wfB = 'workflow-editor-split-b';
  const state = useWorkflowStore.getState();
  const workflow = (name: string, node: FlowNode): WorkflowFileInMemory => ({
    version: 1,
    name,
    savedAt: '2026-10-12T00:00:00.000Z',
    nodes: [node],
    edges: [],
    agents: state.agents,
    roles: state.roles,
    variables: {},
    belongsToProject: state.projectId!,
  });
  useWorkflowStore.setState({
    activeWfId: wfA,
    workflowName: 'Workflow A',
    nodes: [nodeB],
    edges: [],
    workflows: {
      ...state.workflows,
      [wfA]: workflow('Workflow A', nodeA),
      [wfB]: workflow('Workflow B', nodeB),
    },
  });
  return { wfA, wfB };
}

describe('WorkflowEditor characterization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetCanvasStore();
    canvasHarness.storeApis.length = 0;
    canvasHarness.reactFlowProps.length = 0;
    canvasHarness.useRealReactFlow = false;
    canvasHarness.runWorkflow.mockReset().mockResolvedValue(undefined);
    canvasHarness.stopWorkflow.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCanvasStore();
    canvasHarness.useRealReactFlow = false;
  });

  it('keeps the empty-canvas new-project action on the supplied owner callback', async () => {
    const onNewProject = vi.fn();
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <WorkflowEditor onNewProject={onNewProject} />
        </ReactFlowProvider>,
      );
    });

    expect(container.textContent).toContain('canvas.welcome.headline');
    const newProjectButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('menu.newProject'),
    );
    expect(newProjectButton).toBeDefined();

    await act(async () => {
      (newProjectButton as HTMLButtonElement).click();
    });

    expect(onNewProject).toHaveBeenCalledOnce();
    expect(DND_MIME).toBe('application/x-slime-node');
  });

  it('closes the node picker and ignores global picker shortcuts while its editor tab is inactive', async () => {
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <WorkflowEditor isActive />
        </ReactFlowProvider>,
      );
    });
    const activeShortcut = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(activeShortcut));
    expect(activeShortcut.defaultPrevented).toBe(true);
    expect(container.querySelector('input')).not.toBeNull();

    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <WorkflowEditor isActive={false} />
        </ReactFlowProvider>,
      );
    });
    expect(container.querySelector('input')).toBeNull();

    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    const cmdSpace = new KeyboardEvent('keydown', { key: ' ', code: 'Space', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ctrlK);
      window.dispatchEvent(cmdSpace);
    });
    expect(ctrlK.defaultPrevented).toBe(false);
    expect(cmdSpace.defaultPrevented).toBe(false);
    expect(container.querySelector('input')).toBeNull();
  });

  it.each(['Backspace', 'Delete'] as const)(
    'does not let the mounted hidden ReactFlow delete selected nodes with document %s during replay',
    async (key) => {
      await act(async () => {
        await useWorkflowStore.getState().newWorkflowInProject();
      });
      const initial = useWorkflowStore.getState();
      const wfId = initial.activeWfId;
      const workflow = initial.workflows[wfId];
      expect(workflow).toBeDefined();

      const nodes: FlowNode[] = [
        {
          id: 'r11-node-a',
          type: 'base',
          position: { x: 80, y: 60 },
          data: { typeId: 'input.text', label: 'A', params: {}, status: 'idle' },
          selected: true,
        } as FlowNode,
        {
          id: 'r11-node-b',
          type: 'base',
          position: { x: 260, y: 60 },
          data: { typeId: 'input.text', label: 'B', params: {}, status: 'idle' },
          selected: true,
        } as FlowNode,
      ];
      const edges: FlowEdge[] = [{
        id: 'r11-edge-ab',
        source: 'r11-node-a',
        target: 'r11-node-b',
        type: 'kind',
        data: { kind: 'data' },
        selected: true,
      }];
      useWorkflowStore.setState({
        nodes,
        edges,
        selectedIds: nodes.map((node) => node.id),
        workflows: { ...initial.workflows, [wfId]: { ...workflow!, nodes, edges } },
      });

      canvasHarness.useRealReactFlow = true;
      const renderHiddenEditor = (isActive: boolean) => root.render(
        <ReactFlowProvider>
          <div hidden={!isActive} style={{ width: 800, height: 600 }}>
            <WorkflowEditor isActive={isActive} />
          </div>
        </ReactFlowProvider>,
      );
      await act(async () => renderHiddenEditor(true));
      await act(async () => renderHiddenEditor(false));

      const keyDown = () => document.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      }));
      const keyUp = () => document.dispatchEvent(new KeyboardEvent('keyup', {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      }));
      await act(async () => {
        keyDown();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => keyUp());

      expect(useWorkflowStore.getState().nodes.map((node) => node.id)).toEqual(['r11-node-a', 'r11-node-b']);
      expect(useWorkflowStore.getState().edges.map((edge) => edge.id)).toEqual(['r11-edge-ab']);
      const replayProps = canvasHarness.reactFlowProps.at(-1)!;
      expect(replayProps.deleteKeyCode).toBeNull();
      expect(replayProps.disableKeyboardA11y).toBe(true);
      expect(replayProps.nodesDraggable).toBe(false);
      expect(replayProps.nodesConnectable).toBe(false);
      expect(replayProps.elementsSelectable).toBe(false);
      expect(replayProps.edgesReconnectable).toBe(false);
      expect(replayProps.onReconnect).toBeUndefined();

      const replayOnNodesChange = replayProps.onNodesChange as OnNodesChange<FlowNode>;
      const replayOnEdgesChange = replayProps.onEdgesChange as OnEdgesChange<FlowEdge>;
      const replayOnConnect = replayProps.onConnect as (connection: Connection) => void;
      await act(async () => {
        replayOnNodesChange([{ type: 'remove', id: 'r11-node-a' }]);
        replayOnEdgesChange([{ type: 'remove', id: 'r11-edge-ab' }]);
        replayOnConnect({ source: 'r11-node-a', target: 'r11-node-b', sourceHandle: null, targetHandle: null });
      });
      expect(useWorkflowStore.getState().nodes.map((node) => node.id)).toEqual(['r11-node-a', 'r11-node-b']);
      expect(useWorkflowStore.getState().edges.map((edge) => edge.id)).toEqual(['r11-edge-ab']);

      await act(async () => renderHiddenEditor(true));
      const liveProps = canvasHarness.reactFlowProps.at(-1)!;
      expect(liveProps.deleteKeyCode).toEqual(['Backspace', 'Delete']);
      expect(liveProps.disableKeyboardA11y).toBe(false);
      expect(liveProps.nodesDraggable).toBe(true);
      expect(liveProps.nodesConnectable).toBe(true);
      expect(liveProps.elementsSelectable).toBe(true);
      expect(liveProps.edgesReconnectable).toBe(true);
      await act(async () => {
        keyDown();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => keyUp());
      expect(useWorkflowStore.getState().nodes).toHaveLength(0);
      expect(useWorkflowStore.getState().edges).toHaveLength(0);
    },
  );

  it('loads a starter template through the real project workflow store', async () => {
    const template = STARTER_TEMPLATES[0];
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <WorkflowEditor />
        </ReactFlowProvider>,
      );
    });

    const templateNameKey = `starterTemplate.${template.id}.name`;
    const templateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(templateNameKey),
    );
    expect(templateButton).toBeDefined();

    await act(async () => {
      (templateButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const state = useWorkflowStore.getState();
    expect(state.activeWfId).not.toBe('');
    expect(state.workflows[state.activeWfId]).toBeDefined();
    expect(state.nodes).toHaveLength(template.build().nodes.length);
    expect(state.edges).toHaveLength(template.build().edges.length);
    expect(state.workflowName).toContain('canvas.exampleWorkflowName');
  });

  it('uses the App provider for the main canvas and isolates a split canvas provider', async () => {
    await act(async () => {
      await useWorkflowStore.getState().newWorkflowInProject();
    });
    const wfId = useWorkflowStore.getState().activeWfId;
    expect(wfId).not.toBe('');

    const mainProvider = { current: null as unknown };
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <StoreApiProbe capture={mainProvider} />
          <WorkflowEditor />
        </ReactFlowProvider>,
      );
    });

    expect(canvasHarness.storeApis.length).toBeGreaterThan(0);
    const mainFlowState = (canvasHarness.storeApis.at(-1) as { getState: () => unknown }).getState();
    const mainProviderState = (mainProvider.current as { getState: () => unknown }).getState();
    expect(mainFlowState).toBe(mainProviderState);

    canvasHarness.storeApis.length = 0;
    const splitOuterProvider = { current: null as unknown };
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <StoreApiProbe capture={splitOuterProvider} />
          <WorkflowEditor wfId={wfId} />
        </ReactFlowProvider>,
      );
    });

    expect(canvasHarness.storeApis.length).toBeGreaterThan(0);
    const splitOuterState = (splitOuterProvider.current as { getState: () => unknown }).getState();
    expect(
      canvasHarness.storeApis.every(
        (storeApi) => (storeApi as { getState: () => unknown }).getState() !== splitOuterState,
      ),
    ).toBe(true);
    const runButton = container.querySelector('button[title="canvas.split.runTitle"]') as HTMLButtonElement | null;
    expect(runButton).not.toBeNull();
    await act(async () => {
      runButton?.click();
      await Promise.resolve();
    });
    expect(canvasHarness.runWorkflow).toHaveBeenCalledWith({ wfId });
  });

  it('preserves a split graph on mount and writes later node changes back to its workflow', async () => {
    await act(async () => {
      await useWorkflowStore.getState().newWorkflowInProject();
    });
    const wfId = useWorkflowStore.getState().activeWfId;
    const node = {
      id: 'node-1',
      type: 'base',
      position: { x: 10, y: 20 },
      data: { typeId: 'input.text', label: 'Input', params: {}, status: 'idle' },
    } as unknown as FlowNode;
    const before = useWorkflowStore.getState();
    const workflow = before.workflows[wfId];
    expect(workflow).toBeDefined();
    useWorkflowStore.setState({
      nodes: [node],
      edges: [],
      workflows: { ...before.workflows, [wfId]: { ...workflow!, nodes: [node], edges: [] } },
    });

    await act(async () => {
      root.render(<WorkflowEditor wfId={wfId} />);
    });

    const loadedNodes = canvasHarness.reactFlowProps.at(-1)?.nodes as FlowNode[];
    expect(loadedNodes[0]).not.toBe(node);
    expect(loadedNodes[0]?.data).not.toBe(node.data);
    expect(loadedNodes[0]?.data).toMatchObject({ dirty: true });
    expect(node.data).not.toHaveProperty('dirty');

    expect(useWorkflowStore.getState().workflows[wfId]?.nodes).toMatchObject([
      { id: 'node-1', position: { x: 10, y: 20 } },
    ]);

    const onNodesChange = canvasHarness.reactFlowProps.at(-1)?.onNodesChange as
      | ((changes: unknown[]) => void)
      | undefined;
    expect(onNodesChange).toBeDefined();
    await act(async () => {
      onNodesChange?.([{ type: 'position', id: 'node-1', position: { x: 100, y: 200 }, dragging: false }]);
      await Promise.resolve();
    });

    expect(useWorkflowStore.getState().workflows[wfId]?.nodes[0]?.position).toEqual({ x: 100, y: 200 });
  });

  it('loads a new split target when its graph fingerprint matches the previous target', async () => {
    const nodeA = {
      id: 'shared-node',
      type: 'base',
      position: { x: 10, y: 20 },
      data: { typeId: 'input.text', label: 'Workflow A', params: {}, status: 'idle' },
    } as unknown as FlowNode;
    const nodeB = { ...nodeA, data: { ...nodeA.data, label: 'Workflow B' } };
    const { wfA, wfB } = seedSplitWorkflows(nodeA, nodeB);

    await act(async () => {
      root.render(<WorkflowEditor wfId={wfA} />);
    });
    await act(async () => {
      root.render(<WorkflowEditor wfId={wfB} />);
    });

    const displayedNodes = canvasHarness.reactFlowProps.at(-1)?.nodes as FlowNode[];
    expect(displayedNodes[0]?.data.label).toBe('Workflow B');
  });

  it('does not overwrite a different split target while loading it', async () => {
    const nodeA = {
      id: 'shared-node',
      type: 'base',
      position: { x: 10, y: 20 },
      data: { typeId: 'input.text', label: 'Workflow A', params: {}, status: 'idle' },
    } as unknown as FlowNode;
    const nodeB = {
      ...nodeA,
      position: { x: 90, y: 20 },
      data: { ...nodeA.data, label: 'Workflow B' },
    };
    const { wfA, wfB } = seedSplitWorkflows(nodeA, nodeB);

    await act(async () => {
      root.render(<WorkflowEditor wfId={wfA} />);
    });
    await act(async () => {
      root.render(<WorkflowEditor wfId={wfB} />);
    });

    const displayedNodes = canvasHarness.reactFlowProps.at(-1)?.nodes as FlowNode[];
    expect(displayedNodes[0]?.data.label).toBe('Workflow B');
    expect(useWorkflowStore.getState().workflows[wfB]?.nodes[0]?.data.label).toBe('Workflow B');
  });

  it('registers right-box window listeners once and removes the same handlers on unmount', async () => {
    const eventTypes = new Set(['mousemove', 'mouseup', 'blur']);
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      await act(async () => {
        root.render(<ReactFlowProvider><WorkflowEditor /></ReactFlowProvider>);
      });
      const added = addSpy.mock.calls.filter(([type]) => eventTypes.has(String(type)));
      expect(added.map(([type]) => String(type)).sort()).toEqual(['blur', 'mousemove', 'mouseup']);

      act(() => root.unmount());
      root = createRoot(container);
      const removed = removeSpy.mock.calls.filter(([type]) => eventTypes.has(String(type)));
      expect(removed.map(([type]) => String(type)).sort()).toEqual(['blur', 'mousemove', 'mouseup']);
      for (const [type, handler] of added) {
        expect(removed.some(([removedType, removedHandler]) => removedType === type && removedHandler === handler)).toBe(true);
      }
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('suppresses ReactFlow selection sync during right-button box selection', async () => {
    await act(async () => useWorkflowStore.getState().newWorkflowInProject());
    useWorkflowStore.setState({ selectedIds: ['kept-selection'] });
    await act(async () => {
      root.render(<ReactFlowProvider><WorkflowEditor /></ReactFlowProvider>);
    });

    const flow = container.querySelector('[data-testid="workflow-editor-flow"]');
    expect(flow).not.toBeNull();
    await act(async () => {
      flow?.dispatchEvent(new MouseEvent('mousedown', {
        button: 2, clientX: 10, clientY: 10, bubbles: true,
      }));
    });
    const onSelectionChange = canvasHarness.reactFlowProps.at(-1)?.onSelectionChange as
      | ((change: { nodes: FlowNode[] }) => void)
      | undefined;
    expect(onSelectionChange).toBeDefined();
    await act(async () => {
      onSelectionChange?.({ nodes: [{ id: 'replacement' } as FlowNode] });
    });

    expect(useWorkflowStore.getState().selectedIds).toEqual(['kept-selection']);
  });
});
