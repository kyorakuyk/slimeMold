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

  const nodeById = new Map<string, GraphGrowthNode>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) throw new Error(`graph-growth layout 节点 ID 重复：${node.id}`);
    nodeById.set(node.id, node);
  }

  const positions = new Map<string, GraphGrowthPosition>();
  for (const [nodeId, position] of [...cachedPositions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error(`graph-growth layout 缓存坐标无效：${nodeId}`);
    }
    positions.set(nodeId, position);
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
      const y = parent ? parent.y + nodeHeight + verticalGap : 0;
      const strideX = nodeWidth + horizontalGap;
      let slot = 0;
      let candidate: GraphGrowthPosition;
      do {
        candidate = { x: (parent?.x ?? 0) + slot * strideX, y };
        slot += 1;
      } while (!isFree(candidate, positions.values(), nodeWidth, nodeHeight));
      positions.set(node.id, candidate);
      placedAny = true;
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
    const overlaps = candidate.x < position.x + width
      && position.x < candidate.x + width
      && candidate.y < position.y + height
      && position.y < candidate.y + height;
    if (overlaps) return false;
  }
  return true;
}
