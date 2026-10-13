import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const canvasHarness = vi.hoisted(() => ({
  storeApis: [] as unknown[],
  reactFlowProps: [] as Array<Record<string, unknown>>,
  runWorkflow: vi.fn(),
  stopWorkflow: vi.fn(),
}));

vi.mock('@xyflow/react', async (importActual) => {
  const actual = await importActual<typeof import('@xyflow/react')>();
  const React = await import('react');
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
      canvasHarness.storeApis.push(actual.useStoreApi());
      canvasHarness.reactFlowProps.push(props);
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

import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';
import type { FlowNode } from '../types/graph';
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
    canvasHarness.runWorkflow.mockReset().mockResolvedValue(undefined);
    canvasHarness.stopWorkflow.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCanvasStore();
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

  it('loads a starter template through the real project workflow store', async () => {
    const template = STARTER_TEMPLATES[0];
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <WorkflowEditor />
        </ReactFlowProvider>,
      );
    });

    const templateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(template.name),
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
