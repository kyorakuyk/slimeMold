import type { GraphGrowthNode, GraphGrowthNodeKind } from './graphGrowthProjectionModel';

export interface GraphGrowthPosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphGrowthLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalGap?: number;
  verticalGap?: number;
  /** Called once for each cached subtree invalidated by a non-advancing child row. */
  onCacheFallback?: (rootNodeId: string) => void;
}

const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 100;
const DEFAULT_HORIZONTAL_GAP = 80;
const DEFAULT_VERTICAL_GAP = 80;
const KIND_ORDER: Record<GraphGrowthNodeKind, number> = {
  session: 0,
  module: 1,
  task: 2,
  attempt: 3,
};

/** Assign stable positions without moving any coordinate already cached by node ID. */
export function layoutGraphGrowth(
  nodes: readonly GraphGrowthNode[],
  cachedPositions: ReadonlyMap<string, GraphGrowthPosition> = new Map(),
  options: GraphGrowthLayoutOptions = {},
): ReadonlyMap<string, GraphGrowthPosition> {
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP;
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP;
  if (![nodeWidth, nodeHeight].every((size) => Number.isFinite(size) && size > 0)
    || ![horizontalGap, verticalGap].every((gap) => Number.isFinite(gap) && gap >= 0)) {
    throw new Error('graph-growth layout 尺寸与间距必须是有效的非负有限数');
  }
  const horizontalStride = nodeWidth + horizontalGap;
  const verticalStride = nodeHeight + verticalGap;
  if (!Number.isFinite(horizontalStride) || !Number.isFinite(verticalStride)) {
    throw new Error('graph-growth layout overflow：派生间距超出有限数范围');
  }

  const nodeById = new Map<string, GraphGrowthNode>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) throw new Error(`graph-growth layout 节点 ID 重复：${node.id}`);
    nodeById.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parentId && !nodeById.has(node.parentId)) {
      throw new Error(`graph-growth layout missing parent for ${node.id}: ${node.parentId}`);
    }
  }
  const childrenByParent = new Map<string, GraphGrowthNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const positions = new Map<string, GraphGrowthPosition>();
  for (const [nodeId, position] of [...cachedPositions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error(`graph-growth layout 缓存坐标无效：${nodeId}`);
    }
    positions.set(nodeId, position);
  }

  const fallbackCandidates = new Set<string>();
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    let parentId = node.parentId;
    let highestInvalidParentId: string | undefined;
    const visitedParents = new Set<string>();
    while (parentId && !visitedParents.has(parentId)) {
      visitedParents.add(parentId);
      const parentPosition = positions.get(parentId);
      if (parentPosition) {
        const nextY = parentPosition.y + verticalStride;
        if (!Number.isFinite(nextY) || nextY <= parentPosition.y) {
          highestInvalidParentId = parentId;
        } else {
          break;
        }
      }
      parentId = nodeById.get(parentId)?.parentId;
    }
    if (highestInvalidParentId) fallbackCandidates.add(highestInvalidParentId);
  }

  const fallbackRoots = [...fallbackCandidates].filter((nodeId) => {
    let parentId = nodeById.get(nodeId)?.parentId;
    const visitedParents = new Set<string>();
    while (parentId && !visitedParents.has(parentId)) {
      if (fallbackCandidates.has(parentId)) return false;
      visitedParents.add(parentId);
      parentId = nodeById.get(parentId)?.parentId;
    }
    return true;
  });
  for (const rootNodeId of fallbackRoots) {
    const subtree = [rootNodeId];
    const invalidatedNodes = new Set<string>();
    while (subtree.length > 0) {
      const nodeId = subtree.pop()!;
      if (invalidatedNodes.has(nodeId)) continue;
      invalidatedNodes.add(nodeId);
      positions.delete(nodeId);
      for (const child of childrenByParent.get(nodeId) ?? []) subtree.push(child.id);
    }
    options.onCacheFallback?.(rootNodeId);
  }

  let pending = nodes
    .filter((node) => !positions.has(node.id))
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || (left.parentId ?? '').localeCompare(right.parentId ?? '')
      || left.id.localeCompare(right.id));
  while (pending.length > 0) {
    const unresolved: GraphGrowthNode[] = [];
    let placedAny = false;
    for (const node of pending) {
      const parent = node.parentId ? positions.get(node.parentId) : undefined;
      if (node.parentId && !parent) {
        unresolved.push(node);
        continue;
      }
      const firstRowY = parent ? parent.y + verticalStride : 0;
      if (!Number.isFinite(firstRowY)) throw new Error(`graph-growth layout coordinate overflow: ${node.id}.y`);
      const originX = parent?.x ?? 0;
      let row = 0;
      let previousY: number | undefined;
      let placed = false;
      while (!placed) {
        const y = firstRowY + row * verticalStride;
        if (!Number.isFinite(y) || (previousY !== undefined && y <= previousY)) {
          throw new Error(`graph-growth layout coordinate overflow: ${node.id}.y`);
        }
        let slot = 0;
        let previousX: number | undefined;
        while (true) {
          const x = originX + slot * horizontalStride;
          if (!Number.isFinite(x) || (previousX !== undefined && x <= previousX)) break;
          const candidate = { x, y };
          if (isFree(candidate, positions.values(), nodeWidth, nodeHeight)) {
            positions.set(node.id, candidate);
            placed = true;
            placedAny = true;
            break;
          }
          previousX = x;
          slot += 1;
        }
        if (!placed) {
          previousY = y;
          row += 1;
        }
      }
    }
    if (!placedAny) {
      const blocked = unresolved.map((node) => `${node.id}→${node.parentId}`).join(', ');
      throw new Error(`graph-growth layout 存在缺失 parent 或循环：${blocked}`);
    }
    pending = unresolved;
  }
  return positions;
}

function isFree(
  candidate: GraphGrowthPosition,
  occupied: Iterable<GraphGrowthPosition>,
  width: number,
  height: number,
): boolean {
  for (const position of occupied) {
    const overlaps = Math.abs(candidate.x - position.x) < width
      && Math.abs(candidate.y - position.y) < height;
    if (overlaps) return false;
  }
  return true;
}
