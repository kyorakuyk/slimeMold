// 节点几何布局的纯计算（对齐 / 分布）。
// 这些函数只依赖传入的节点列表与选中集合，不触碰 store 单例，
// 因而可独立测试、避免 workflowStore 进一步膨胀。
// 从 workflowStore 的 alignSelected / distributeSelected action 内联逻辑抽离，行为等价。

import type { FlowNode } from '../types/graph';

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter';
export type DistributeAxis = 'x' | 'y';

/**
 * 按 mode 将选中的节点对齐到它们的共享边界/中心。
 * - 少于 2 个选中节点时不改动（原行为直接返回）。
 * 非选中节点原样返回。
 */
export function alignNodes(
  nodes: FlowNode[],
  selectedIds: Iterable<string>,
  mode: AlignMode,
): FlowNode[] {
  const selIds = new Set(selectedIds);
  const sel = nodes.filter((n) => selIds.has(n.id));
  if (sel.length < 2) return nodes;
  const minX = Math.min(...sel.map((n) => n.position.x));
  const maxX = Math.max(...sel.map((n) => n.position.x));
  const minY = Math.min(...sel.map((n) => n.position.y));
  const maxY = Math.max(...sel.map((n) => n.position.y));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const mapBy = (n: FlowNode): [number, number] => {
    switch (mode) {
      case 'left': return [minX, n.position.y];
      case 'right': return [maxX, n.position.y];
      case 'top': return [n.position.x, minY];
      case 'bottom': return [n.position.x, maxY];
      case 'hcenter': return [cx, n.position.y];
      case 'vcenter': return [n.position.x, cy];
      default: return [n.position.x, n.position.y];
    }
  };
  return nodes.map((n) => {
    if (!selIds.has(n.id)) return n;
    const [x, y] = mapBy(n);
    return { ...n, position: { x, y } };
  });
}

/**
 * 沿 axis 将选中的节点等距分布（首尾节点位置固定，中间节点均匀插入）。
 * - 少于 3 个选中节点时不改动（原行为直接返回）。
 * 非选中节点原样返回。
 */
export function distributeNodes(
  nodes: FlowNode[],
  selectedIds: Iterable<string>,
  axis: DistributeAxis,
): FlowNode[] {
  const selIds = new Set(selectedIds);
  const sel = nodes.filter((n) => selIds.has(n.id));
  if (sel.length < 3) return nodes;
  const sorted = [...sel].sort((a, b) =>
    axis === 'x' ? a.position.x - b.position.x : a.position.y - b.position.y,
  );
  const first = sorted[0].position[axis];
  const last = sorted[sorted.length - 1].position[axis];
  const step = (last - first) / (sorted.length - 1);
  const targets = new Map(sorted.map((n, i) => [n.id, first + step * i]));
  return nodes.map((n) => {
    if (!targets.has(n.id)) return n;
    const v = targets.get(n.id)!;
    return { ...n, position: { ...n.position, [axis]: v } };
  });
}
