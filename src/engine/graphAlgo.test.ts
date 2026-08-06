import { describe, it, expect } from 'vitest';
import type { FlowEdge } from '../types';
import {
  collectReachable,
  computeDownstream,
  computeScopeClusters,
  isReachable,
  scopesOfNode,
} from './graphAlgo';

function edge(source: string, target: string, extra?: Partial<FlowEdge['data']>): FlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { kind: 'data', ...extra },
  } as FlowEdge;
}

describe('computeDownstream', () => {
  it('返回某节点的全部下游（BFS，含自身不返回但含直接下游）', () => {
    // a -> b -> c ; a -> d
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd')];
    const down = computeDownstream('a', edges);
    expect([...down].sort()).toEqual(['b', 'c', 'd']);
  });

  it('不含 startId 自身', () => {
    const edges = [edge('a', 'b')];
    const down = computeDownstream('a', edges);
    expect(down.has('a')).toBe(false);
    expect(down.has('b')).toBe(true);
  });

  it('孤立节点返回空集', () => {
    expect([...computeDownstream('x', [edge('a', 'b')])]).toEqual([]);
  });

  it('汇聚型 DAG 不重复计数、全收集', () => {
    // a->b, a->c, b->d, c->d
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    expect([...computeDownstream('a', edges)].sort()).toEqual(['b', 'c', 'd']);
  });

  it('不改入参 edges / 多次调用幂等', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const first = computeDownstream('a', edges);
    const second = computeDownstream('a', edges);
    expect(first).not.toBe(second); // 返回新集合
    expect([...first].sort()).toEqual([...second].sort());
    expect(edges).toHaveLength(2);
  });
});

describe('isReachable', () => {
  it('直连可达', () => {
    expect(isReachable('a', 'b', [edge('a', 'b')])).toBe(true);
  });

  it('多跳可达', () => {
    expect(isReachable('a', 'c', [edge('a', 'b'), edge('b', 'c')])).toBe(true);
  });

  it('不可达返回 false', () => {
    expect(isReachable('a', 'c', [edge('a', 'b'), edge('x', 'c')])).toBe(false);
  });

  it('起点即终点视为可达', () => {
    expect(isReachable('a', 'a', [edge('a', 'b')])).toBe(true);
  });

  it('自环可达', () => {
    expect(isReachable('a', 'a', [edge('a', 'a')])).toBe(true);
  });
});

describe('collectReachable (循环体)', () => {
  it('从 start 出发、绕回 gate 前的可达节点集合，不含 gate 自身', () => {
    // gate.pass -> s ; s -> t ; t -> gate.control (回指)
    const edges = [edge('s', 't'), edge('t', 'gate'), edge('gate', 's')];
    const out = new Set<string>();
    collectReachable('s', 'gate', edges, out);
    expect([...out].sort()).toEqual(['s', 't']);
    expect(out.has('gate')).toBe(false);
  });

  it('不经过 gate 的旁路节点也纳入', () => {
    const edges = [edge('s', 't'), edge('s', 'branch'), edge('t', 'gate'), edge('gate', 's')];
    const out = new Set<string>();
    collectReachable('s', 'gate', edges, out);
    expect([...out].sort()).toEqual(['branch', 's', 't']);
  });

  it('不把写到 gate 的边当成继续前进（避免把 gate 加进 body）', () => {
    const edges = [edge('s', 'gate')];
    const out = new Set<string>();
    collectReachable('s', 'gate', edges, out);
    expect([...out]).toEqual(['s']);
  });

  it('重复调用同一 out 集合幂等、不重复', () => {
    const edges = [edge('s', 't'), edge('t', 'gate'), edge('gate', 's')];
    const out = new Set<string>();
    collectReachable('s', 'gate', edges, out);
    collectReachable('s', 'gate', edges, out);
    expect(out.size).toBe(2);
  });
});

describe('scopesOfNode + computeScopeClusters', () => {
  it('scopesOfNode 收集指向该节点的 task 边 scope 并集', () => {
    const edges = [
      edge('a', 'x', { kind: 'task', scope: ['s1'] }),
      edge('b', 'x', { kind: 'task', scope: ['s2'] }),
      edge('c', 'x', { kind: 'data' }), // 无 scope
    ];
    expect(scopesOfNode('x', edges).sort()).toEqual(['s1', 's2']);
  });

  it('无 scope 边返回空', () => {
    expect(scopesOfNode('x', [edge('a', 'x')])).toEqual([]);
  });

  it('互不冲突节点各自独立成簇', () => {
    const edges = [
      edge('a', 'n1', { kind: 'task', scope: ['s1'] }),
      edge('b', 'n2', { kind: 'task', scope: ['s2'] }),
    ];
    const clusters = computeScopeClusters(['n1', 'n2'], edges);
    // 两个独立簇
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.flat())).toEqual(new Set(['n1', 'n2']));
  });

  it('scope 相交的节点被并入同一串行簇', () => {
    const edges = [
      edge('a', 'n1', { kind: 'task', scope: ['common'] }),
      edge('b', 'n2', { kind: 'task', scope: ['common'] }),
    ];
    const clusters = computeScopeClusters(['n1', 'n2'], edges);
    expect(clusters).toHaveLength(1);
    expect([...clusters[0]].sort()).toEqual(['n1', 'n2']);
  });

  it('三节点：一对冲突、第三者独立', () => {
    const edges = [
      edge('a', 'n1', { kind: 'task', scope: ['s1'] }),
      edge('b', 'n2', { kind: 'task', scope: ['s1'] }), // n1,n2 冲突
      edge('c', 'n3', { kind: 'task', scope: ['s3'] }),
    ];
    const clusters = computeScopeClusters(['n1', 'n2', 'n3'], edges);
    expect(clusters).toHaveLength(2);
    const conflict = clusters.find((c) => c.length === 2)!;
    expect([...conflict].sort()).toEqual(['n1', 'n2']);
    const alone = clusters.find((c) => c.length === 1)!;
    expect(alone).toEqual(['n3']);
  });

  it('多对冲突形成连通簇（传递性：A-B 冲突，B-C 冲突 => A,B,C 同簇）', () => {
    const edges = [
      edge('a', 'n1', { kind: 'task', scope: ['s1'] }),
      edge('b', 'n2', { kind: 'task', scope: ['s1', 's2'] }), // 与 n1 共享 s1
      edge('c', 'n3', { kind: 'task', scope: ['s2'] }), // 与 n2 共享 s2
    ];
    const clusters = computeScopeClusters(['n1', 'n2', 'n3'], edges);
    expect(clusters).toHaveLength(1);
    expect([...clusters[0]].sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('无边的层：每个节点独立成簇', () => {
    const clusters = computeScopeClusters(['n1', 'n2', 'n3'], []);
    expect(clusters).toHaveLength(3);
  });

  it('簇内顺序保持 layer 中出现的顺序（串行执行确定性）', () => {
    const edges = [
      edge('a', 'n2', { kind: 'task', scope: ['common'] }),
      edge('b', 'n1', { kind: 'task', scope: ['common'] }),
    ];
    // layer 顺序 n1 在前
    const clusters = computeScopeClusters(['n1', 'n2'], edges);
    expect(clusters[0]).toEqual(['n1', 'n2']);
  });
});
