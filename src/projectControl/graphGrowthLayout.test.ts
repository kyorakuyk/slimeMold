import { describe, expect, it } from 'vitest';
import type { GraphGrowthNode, GraphGrowthNodeKind } from './graphGrowthProjection';
import { layoutGraphGrowth } from './graphGrowthLayout';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;

function growthNode(
  id: string,
  kind: GraphGrowthNodeKind,
  parentId?: string,
): GraphGrowthNode {
  return {
    id,
    kind,
    label: id,
    status: 'idle',
    sessionId: 'session-layout',
    ...(parentId ? { parentId } : {}),
    eventIds: [],
    evidenceIds: [],
    leaseHeld: false,
    pulse: false,
    scar: false,
  };
}

function expectNoOverlaps(
  nodes: readonly GraphGrowthNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
): void {
  const rectangles = nodes.map((node) => {
    const position = positions.get(node.id);
    expect(position).toBeDefined();
    return { id: node.id, x: position!.x, y: position!.y };
  });
  for (let left = 0; left < rectangles.length; left += 1) {
    for (let right = left + 1; right < rectangles.length; right += 1) {
      const a = rectangles[left];
      const b = rectangles[right];
      const overlaps = Math.abs(a.x - b.x) < NODE_WIDTH
        && Math.abs(a.y - b.y) < NODE_HEIGHT;
      expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe('layoutGraphGrowth', () => {
  it('keeps existing coordinates fixed while inserting new descendants below their parents', () => {
    const session = growthNode('session:1', 'session');
    const moduleA = growthNode('module:1:a', 'module', session.id);
    const moduleB = growthNode('module:1:b', 'module', session.id);
    const initialNodes = [moduleB, session, moduleA];
    const initial = layoutGraphGrowth(initialNodes);
    const taskA = growthNode('task:1:a', 'task', moduleA.id);
    const taskB = growthNode('task:1:b', 'task', moduleB.id);
    const attemptA = growthNode('attempt:1:a:1', 'attempt', taskA.id);
    const expandedNodes = [...initialNodes, attemptA, taskB, taskA];
    const expanded = layoutGraphGrowth(expandedNodes, initial);

    for (const node of initialNodes) {
      expect(expanded.get(node.id)).toEqual(initial.get(node.id));
    }
    expect(expanded.get(taskA.id)!.y).toBeGreaterThan(expanded.get(moduleA.id)!.y);
    expect(expanded.get(taskB.id)!.y).toBeGreaterThan(expanded.get(moduleB.id)!.y);
    expect(expanded.get(attemptA.id)!.y).toBeGreaterThan(expanded.get(taskA.id)!.y);
    expectNoOverlaps(expandedNodes, expanded);
  });

  it('uses node IDs and stable ordering so the same input and cache yield the same layout', () => {
    const session = growthNode('session:stable', 'session');
    const module = growthNode('module:stable', 'module', session.id);
    const taskA = growthNode('task:stable:a', 'task', module.id);
    const taskB = growthNode('task:stable:b', 'task', module.id);
    const nodes = [session, module, taskA, taskB];
    const cached = layoutGraphGrowth(nodes.slice(0, 2));
    const first = layoutGraphGrowth(nodes, cached);
    const reordered = layoutGraphGrowth([...nodes].reverse(), cached);
    const entries = (positions: ReadonlyMap<string, { x: number; y: number }>) => (
      [...positions.entries()].sort(([left], [right]) => left.localeCompare(right))
    );

    expect(entries(first)).toEqual(entries(reordered));
    expectNoOverlaps(nodes, first);
  });

  it('rejects a visible child whose parent is absent from the current graph even if cached', () => {
    const session = growthNode('session:removed-parent', 'session');
    const parent = growthNode('module:removed-parent', 'module', session.id);
    const cached = layoutGraphGrowth([session, parent]);
    const orphan = growthNode('task:orphan', 'task', parent.id);

    expect(() => layoutGraphGrowth([orphan], cached)).toThrow(/missing parent|parent.*缺失/i);
  });

  it('rejects finite layout options whose derived coordinates overflow', () => {
    const roots = [
      growthNode('session:overflow:a', 'session'),
      growthNode('session:overflow:b', 'session'),
    ];

    expect(() => layoutGraphGrowth(roots, new Map(), {
      nodeWidth: Number.MAX_VALUE,
      horizontalGap: Number.MAX_VALUE,
    })).toThrow(/overflow|finite|尺寸/i);
  });

  it('finds a lower free slot when large cached coordinates cannot advance horizontally', () => {
    const session = growthNode('session:large-coordinate', 'session');
    const module = growthNode('module:large-coordinate', 'module', session.id);
    const existingTask = growthNode('task:large-coordinate:existing', 'task', module.id);
    const addedTask = growthNode('task:large-coordinate:added', 'task', module.id);
    const cached = new Map([
      [module.id, { x: Number.MAX_VALUE, y: 0 }],
      [existingTask.id, { x: Number.MAX_VALUE, y: NODE_HEIGHT + 80 }],
    ]);

    const positions = layoutGraphGrowth([session, module, existingTask, addedTask], cached);

    expect(positions.get(addedTask.id)).not.toEqual(positions.get(existingTask.id));
    expect(positions.get(addedTask.id)!.y).toBeGreaterThan(positions.get(module.id)!.y + NODE_HEIGHT);
    expectNoOverlaps([session, module, existingTask, addedTask], positions);
  });
});
