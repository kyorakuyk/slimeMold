import { describe, it, expect } from 'vitest';
import type { FlowNode } from '../types';
import { alignNodes, distributeNodes } from './nodeLayout';

function mkNode(id: string, x: number, y: number): FlowNode {
  return {
    id,
    type: 'base',
    position: { x, y },
    data: {
      typeId: 'input.text',
      label: id,
      params: {},
      status: 'idle',
      bypass: false,
      mute: false,
    },
  } as FlowNode;
}

describe('nodeLayout 纯几何（从 workflowStore 抽离，行为等价）', () => {
  describe('alignNodes', () => {
    const nodes = [mkNode('a', 0, 0), mkNode('b', 100, 50), mkNode('c', 40, 200), mkNode('d', 999, 999)];

    it('选中不足 2 个时原样返回', () => {
      expect(alignNodes(nodes, ['a'], 'left')).toBe(nodes);
    });

    it('left 对齐到选中节点最小 x，y 不变', () => {
      const out = alignNodes(nodes, ['a', 'b', 'c'], 'left');
      const sel = out.filter((n) => ['a', 'b', 'c'].includes(n.id));
      expect(sel.every((n) => n.position.x === 0)).toBe(true); // minX of a/b/c = 0
      // 非选中节点 d 不动
      const d = out.find((n) => n.id === 'd')!;
      expect(d.position).toEqual({ x: 999, y: 999 });
      // 选中节点 y 保持不变
      expect(out.find((n) => n.id === 'b')!.position.y).toBe(50);
    });

    it('right 对齐到选中节点最大 x', () => {
      const out = alignNodes(nodes, ['a', 'b', 'c'], 'right');
      const sel = out.filter((n) => ['a', 'b', 'c'].includes(n.id));
      expect(sel.every((n) => n.position.x === 100)).toBe(true); // maxX of a/b/c = 100
    });

    it('top / bottom 对齐到选中节点 min/max y', () => {
      const top = alignNodes(nodes, ['a', 'b', 'c'], 'top');
      expect(top.filter((n) => ['a', 'b', 'c'].includes(n.id)).every((n) => n.position.y === 0)).toBe(true);
      const bottom = alignNodes(nodes, ['a', 'b', 'c'], 'bottom');
      expect(bottom.filter((n) => ['a', 'b', 'c'].includes(n.id)).every((n) => n.position.y === 200)).toBe(true);
    });

    it('hcenter / vcenter 对齐到选中节点中心', () => {
      // a(0,0) b(100,50) c(40,200) -> cx=(0+100)/2=50, cy=(0+200)/2=100
      const hc = alignNodes(nodes, ['a', 'b', 'c'], 'hcenter');
      expect(hc.find((n) => n.id === 'a')!.position.x).toBe(50);
      expect(hc.find((n) => n.id === 'a')!.position.y).toBe(0); // y 不变
      const vc = alignNodes(nodes, ['a', 'b', 'c'], 'vcenter');
      expect(vc.find((n) => n.id === 'b')!.position.y).toBe(100);
      expect(vc.find((n) => n.id === 'b')!.position.x).toBe(100); // x 不变
    });

    it('不修改原数组（纯函数）', () => {
      const before = nodes.map((n) => ({ ...n.position }));
      alignNodes(nodes, ['a', 'b', 'c'], 'left');
      expect(nodes.map((n) => ({ ...n.position }))).toEqual(before);
    });
  });

  describe('distributeNodes', () => {
    const nodes = [mkNode('a', 0, 0), mkNode('b', 50, 0), mkNode('c', 200, 0), mkNode('d', 999, 999)];

    it('选中不足 3 个时原样返回', () => {
      expect(distributeNodes(nodes, ['a', 'b'], 'x')).toBe(nodes);
    });

    it('沿 x 等距分布：首尾固定，中间均匀插入', () => {
      const out = distributeNodes(nodes, ['a', 'b', 'c'], 'x');
      const ax = out.find((n) => n.id === 'a')!.position.x;
      const bx = out.find((n) => n.id === 'b')!.position.x;
      const cx = out.find((n) => n.id === 'c')!.position.x;
      expect(ax).toBe(0); // 首固定
      expect(cx).toBe(200); // 尾固定
      expect(bx).toBe(100); // 中间均匀 (0 + 200)/2
    });

    it('沿 y 等距分布', () => {
      const v = [mkNode('a', 0, 0), mkNode('b', 0, 30), mkNode('c', 0, 90)];
      const out = distributeNodes(v, ['a', 'b', 'c'], 'y');
      expect(out.find((n) => n.id === 'b')!.position.y).toBe(45); // (0+90)/2
    });

    it('非选中节点不动', () => {
      const out = distributeNodes(nodes, ['a', 'replace'], 'x');
      const d = out.find((n) => n.id === 'd')!;
      expect(d.position).toEqual({ x: 999, y: 999 });
    });
  });
});
