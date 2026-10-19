import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphGrowthProjection, GraphGrowthNode, GraphGrowthNodeKind, GraphGrowthStatus } from '../projectControl/graphGrowthProjection';

const graphHarness = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('@xyflow/react', async (importActual) => {
  const actual = await importActual<typeof import('@xyflow/react')>();
  const React = await import('react');
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
      graphHarness.props.push(props);
      const nodes = props.nodes as Array<{
        id: string;
        type: string;
        position: { x: number; y: number };
        data: unknown;
      }>;
      const nodeTypes = props.nodeTypes as Record<string, React.ComponentType<Record<string, unknown>>>;
      return React.createElement(
        'div',
        { 'data-testid': 'living-graph-flow' },
        ...nodes.map((node) => React.createElement(nodeTypes[node.type], {
          key: node.id,
          id: node.id,
          type: node.type,
          data: node.data,
          selected: false,
          dragging: false,
          isConnectable: false,
          xPos: node.position.x,
          yPos: node.position.y,
        })),
        props.children,
      );
    },
    Panel: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
    Background: () => null,
    Handle: () => null,
  };
});

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) => (
    options ? `${key} ${Object.values(options).join(' ')}` : key
  ),
}));

import { ReactFlowProvider } from '@xyflow/react';
import LivingGraph from './LivingGraph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function graphNode(
  id: string,
  kind: GraphGrowthNodeKind,
  status: GraphGrowthStatus,
  parentId?: string,
  overrides: Partial<GraphGrowthNode> = {},
): GraphGrowthNode {
  return {
    id,
    kind,
    label: id,
    status,
    sessionId: 'session-1',
    ...(parentId ? { parentId } : {}),
    ...(kind === 'session' ? {} : { graphId: 'graph-1' }),
    ...(kind === 'module' || kind === 'task' || kind === 'attempt' ? { moduleId: 'module-1' } : {}),
    ...(kind === 'task' || kind === 'attempt' ? { taskId: id.replace(/^(task|attempt):/, '') } : {}),
    ...(kind === 'attempt' ? { attemptId: id, attempt: 1 } : {}),
    eventIds: [`event-${id}`],
    evidenceIds: status === 'succeeded' ? [`evidence-${id}`] : [],
    leaseHeld: status === 'running',
    pulse: status === 'running',
    scar: false,
    ...overrides,
  };
}

function projection(
  nodes: GraphGrowthNode[],
  options: Partial<GraphGrowthProjection> = {},
): GraphGrowthProjection {
  return {
    uptoSeq: 20,
    lastSequence: 20,
    nodes,
    edges: [],
    flow: [],
    scars: [],
    rings: [],
    capsules: [],
    markers: [],
    legacyGraphIds: [],
    ...options,
  };
}

function getNode(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-graph-node-id]'))
    .find((element) => element.dataset.graphNodeId === id);
}

function latestFlowProps(): Record<string, unknown> {
  return graphHarness.props.at(-1) ?? {};
}

describe('LivingGraph', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    graphHarness.props = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders an empty state without mounting an editable React Flow canvas', async () => {
    await act(async () => {
      root.render(<LivingGraph projection={projection([], { lastSequence: 0, uptoSeq: 0 })} />);
    });

    expect(container.textContent).toContain('canvas.livingGraph.empty');
    expect(container.querySelector('[data-testid="living-graph-flow"]')).toBeNull();
    expect(graphHarness.props).toHaveLength(0);
  });

  it('renders growth statuses, provenance, rings, scars, and only read-only flow props', async () => {
    const session = graphNode('session:1', 'session', 'idle');
    const module = graphNode('module:1', 'module', 'running', session.id);
    const statuses: GraphGrowthStatus[] = [
      'queued', 'running', 'waiting-feedback', 'blocked', 'succeeded',
      'unverified', 'failed', 'unknown', 'cancelled',
    ];
    const tasks = statuses.map((status) => graphNode(
      `task:${status}`,
      'task',
      status,
      module.id,
      { taskId: `task-${status}`, eventIds: [`trigger-${status}`] },
    ));
    const succeededAttempt = graphNode('attempt:success', 'attempt', 'succeeded', 'task:succeeded', {
      taskId: 'task-succeeded',
      attemptId: 'attempt:success',
      evidenceIds: ['evidence-success'],
      acceptanceId: 'acceptance-success',
    });
    const failedScar = graphNode('attempt:scar', 'attempt', 'failed', 'task-failed', {
      taskId: 'task-failed',
      attemptId: 'attempt:scar',
      scar: true,
    });
    const unknownAttempt = graphNode('attempt:unknown', 'attempt', 'unknown', 'task-unknown', {
      taskId: 'task-unknown',
      attemptId: 'attempt:unknown',
    });
    const rings = [
      { id: 'ring:success', taskId: 'task-succeeded', attemptId: 'attempt:success', outcome: 'succeeded' as const, eventId: 'ring-success-event' },
      { id: 'ring:scar', taskId: 'task-failed', attemptId: 'attempt:scar', outcome: 'failed' as const, eventId: 'ring-failed-event' },
      { id: 'ring:unknown', taskId: 'task-unknown', attemptId: 'attempt:unknown', outcome: 'unknown' as const, eventId: 'ring-unknown-event' },
    ];
    const edge = {
      id: 'flow:success',
      sourceId: module.id,
      targetId: 'task:succeeded',
      kind: 'hierarchy' as const,
      eventIds: ['flow-event'],
      flowCount: 3,
    };

    await act(async () => {
      root.render(<LivingGraph projection={projection([
        session,
        module,
        ...tasks,
        succeededAttempt,
        failedScar,
        unknownAttempt,
      ], { rings, edges: [edge] })} />);
    });

    for (const status of ['idle', ...statuses]) {
      expect(container.querySelector(`[data-growth-status="${status}"]`)).toBeTruthy();
    }
    expect(getNode(container, 'task:running')?.className).toContain('motion-reduce:animate-none');
    expect(getNode(container, 'task:blocked')?.style.borderColor).toBe('var(--sm-run)');
    expect(getNode(container, 'task:succeeded')?.style.borderColor).toBe('var(--sm-ok)');
    expect(getNode(container, 'task:failed')?.style.borderColor).toBe('var(--sm-err)');
    expect(getNode(container, 'task:unknown')?.style.borderStyle).toBe('dashed');
    expect(container.querySelector('[data-testid="living-graph-ring-attempt:success"]')?.getAttribute('data-outcome'))
      .toBe('succeeded');
    expect(container.querySelector('[data-testid="living-graph-ring-attempt:scar"]')?.getAttribute('data-outcome'))
      .toBe('failed');
    expect(container.querySelector('[data-testid="living-graph-ring-attempt:unknown"]')).toBeNull();
    expect(container.querySelector('[data-testid="living-graph-scar-attempt:scar"]')).toBeTruthy();

    const flowProps = latestFlowProps();
    expect(flowProps).toMatchObject({
      nodesDraggable: false,
      nodesConnectable: false,
      elementsSelectable: false,
      selectionOnDrag: false,
      deleteKeyCode: null,
    });
    expect(flowProps.onConnect).toBeUndefined();
    const renderedEdge = (flowProps.edges as Array<{ id: string; style: { strokeWidth: number } }>)
      .find((candidate) => candidate.id === edge.id);
    expect(renderedEdge?.style.strokeWidth).toBeGreaterThan(2);

    const clicked = (flowProps.nodes as Array<{ id: string }>).find((node) => node.id === 'task:failed');
    await act(async () => {
      (flowProps.onNodeClick as ((event: unknown, node: { id: string }) => void) | undefined)?.({}, clicked!);
    });
    expect(container.querySelector('[data-testid="living-graph-event-details"]')?.textContent)
      .toContain('trigger-failed');
  });

  it('collapses evidence-backed modules, expands on demand, and hides detail at far zoom', async () => {
    const session = graphNode('session:1', 'session', 'succeeded');
    const module = graphNode('module:1', 'module', 'succeeded', session.id);
    const task = graphNode('task:1', 'task', 'succeeded', module.id, {
      taskId: 'task-1',
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
    });
    const attempt = graphNode('attempt:1', 'attempt', 'succeeded', task.id, {
      taskId: 'task-1',
      attemptId: 'attempt:1',
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
    });
    const capsule = {
      id: 'capsule:graph-1:module-1',
      moduleId: 'module-1',
      graphId: 'graph-1',
      taskIds: ['task-1'],
      completionBasis: 'evidence-backed' as const,
      evidenceRefs: ['evidence-1'],
      acceptanceRefs: ['acceptance-1'],
      sourceVersion: 20,
      eventIds: ['event-capsule'],
    };

    await act(async () => {
      root.render(<LivingGraph projection={projection([session, module, task, attempt], { capsules: [capsule] })} />);
    });
    expect(getNode(container, task.id)).toBeUndefined();
    const capsuleToggle = container.querySelector<HTMLButtonElement>(
      `[data-testid="living-graph-capsule-toggle-${module.id}"]`,
    );
    expect(capsuleToggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      capsuleToggle?.click();
    });
    expect(getNode(container, task.id)).toBeTruthy();
    expect(getNode(container, attempt.id)).toBeTruthy();

    const flowProps = latestFlowProps();
    await act(async () => {
      (flowProps.onMoveEnd as ((event: unknown, viewport: { x: number; y: number; zoom: number }) => void) | undefined)
        ?.({}, { x: 0, y: 0, zoom: 0.4 });
    });
    expect(getNode(container, task.id)).toBeUndefined();
    expect(getNode(container, module.id)).toBeTruthy();
  });
});
