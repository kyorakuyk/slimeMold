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
      const overlaps = a.x < b.x + NODE_WIDTH
        && b.x < a.x + NODE_WIDTH
        && a.y < b.y + NODE_HEIGHT
        && b.y < a.y + NODE_HEIGHT;
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
});
