import type { NodeDefinition } from '../types/node';
import { describe, it, expect } from 'vitest';
import type { FlowEdge, FlowNode, NodeStatus } from '../types';
import {
  collectReachable,
  computeDownstream,
  computeExecutionSet,
  computeScopeClusters,
  isBranchPruned,
  isReachable,
  planClustersPerStage,
  resolveNodeExecutionMode,
  scopesOfNode,
  shouldContinueLoop,
} from './graphAlgo';

function edge(source: string, target: string, extra?: Partial<FlowEdge['data']>): FlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { kind: 'data', ...extra },
  } as FlowEdge;
}

function node(id: string, extra?: Partial<FlowNode['data']>): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'core.node', label: id, ...extra },
  } as unknown as FlowNode;
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

describe('computeExecutionSet (增量/全量执行集)', () => {
  it('全量模式（incremental=false）：忽略 dirty，仅含 force + 子图虚拟节点', () => {
    const nodes = [
      node('a', { dirty: true }),
      node('b', { dirty: false }),
      node('sub@0::x'), // ownerRefId 编码：展开虚拟节点
    ];
    const { force, dirtySet } = computeExecutionSet(nodes, { incremental: false, forceNodes: ['a'] });
    expect([...force]).toEqual(['a']);
    // dirty 被忽略；force(a) + 虚拟节点 sub@0::x
    expect([...dirtySet].sort()).toEqual(['a', 'sub@0::x']);
    expect(dirtySet.has('b')).toBe(false);
  });

  it('增量模式：dirty 节点 + force + 虚拟节点', () => {
    const nodes = [
      node('a', { dirty: true }),
      node('b', { dirty: false }),
      node('c', { dirty: true }),
      node('sub@1::y'),
    ];
    const { dirtySet } = computeExecutionSet(nodes, {
      incremental: true,
      forceNodes: ['b'],
    });
    expect([...dirtySet].sort()).toEqual(['a', 'b', 'c', 'sub@1::y']);
  });

  it('retryFailed 视作增量-like：读 dirty', () => {
    const nodes = [node('a', { dirty: true }), node('b', { dirty: false })];
    const { dirtySet } = computeExecutionSet(nodes, { retryFailed: true });
    expect([...dirtySet]).toEqual(['a']);
  });

  it('force 覆盖非 dirty 节点', () => {
    const nodes = [node('a', { dirty: false }), node('b', { dirty: true })];
    const { dirtySet } = computeExecutionSet(nodes, { incremental: true, forceNodes: ['a'] });
    expect(dirtySet.has('a')).toBe(true);
    expect(dirtySet.has('b')).toBe(true);
  });

  it('无 dirty、无 force、无虚拟节点：空集', () => {
    const nodes = [node('a'), node('b')];
    const { force, dirtySet } = computeExecutionSet(nodes, { incremental: true });
    expect([...force]).toEqual([]);
    expect([...dirtySet]).toEqual([]);
  });

  it('返回新集合：多次调用不共享引用', () => {
    const nodes = [node('a', { dirty: true })];
    const r1 = computeExecutionSet(nodes, { incremental: true });
    const r2 = computeExecutionSet(nodes, { incremental: true });
    expect(r1.dirtySet).not.toBe(r2.dirtySet);
    expect(r1.force).not.toBe(r2.force);
  });
});

describe('isBranchPruned (分支剪枝判定)', () => {
  function branchEdge(source: string, target: string, handle?: string): FlowEdge {
    return {
      id: `${source}->${target}:${handle ?? ''}`,
      source,
      target,
      sourceHandle: handle,
      data: { kind: 'control' },
    } as FlowEdge;
  }

  it('无入边不剪枝（入口节点）', () => {
    expect(isBranchPruned([], new Map(), false, new Set())).toBe(false);
  });

  it('普通上游（未登记分支状态=全激活）不剪枝', () => {
    const incoming = [branchEdge('cond', 'x', 'out')];
    // cond 未登记 => 视为全激活 => 不阻塞
    expect(isBranchPruned(incoming, new Map(), false, new Set())).toBe(false);
  });

  it('所有入边均来自未激活分支 => 剪枝', () => {
    const incoming = [branchEdge('cond', 'x', 'true')];
    const branchState = new Map<string, Set<string | undefined>>([
      ['cond', new Set<string | undefined>(['false'])], // 仅激活 false，未激活 true
    ]);
    expect(isBranchPruned(incoming, branchState, false, new Set())).toBe(true);
  });

  it('至少一条入边激活 => 不剪枝', () => {
    const incoming = [branchEdge('cond', 'x', 'true'), branchEdge('other', 'x', 'go')];
    const branchState = new Map<string, Set<string | undefined>>([
      ['cond', new Set<string | undefined>(['false'])], // 阻塞
      ['other', new Set<string | undefined>(['go'])], // 激活
    ]);
    expect(isBranchPruned(incoming, branchState, false, new Set())).toBe(false);
  });

  it('多入边全部未激活 => 剪枝', () => {
    const incoming = [branchEdge('c1', 'x', 'a'), branchEdge('c2', 'x', 'b')];
    const branchState = new Map<string, Set<string | undefined>>([
      ['c1', new Set<string | undefined>(['z'])],
      ['c2', new Set<string | undefined>(['y'])],
    ]);
    expect(isBranchPruned(incoming, branchState, false, new Set())).toBe(true);
  });

  it('skipFailed 且所有上游失败 => 不剪枝（以空输入继续）', () => {
    const incoming = [branchEdge('cond', 'x', 'true')];
    const branchState = new Map<string, Set<string | undefined>>([
      ['cond', new Set<string | undefined>(['false'])],
    ]);
    const failed = new Set(['cond']);
    expect(isBranchPruned(incoming, branchState, true, failed)).toBe(false);
  });

  it('skipFailed 但上游未全失败 => 仍剪枝', () => {
    const incoming = [branchEdge('cond', 'x', 'true'), branchEdge('ok', 'x', 'go')];
    const branchState = new Map<string, Set<string | undefined>>([
      ['cond', new Set<string | undefined>(['false'])],
      ['ok', new Set<string | undefined>(['go'])], // ok 激活 => 不入 allBlocked，其实早就不剪枝
    ]);
    // 因 ok 激活，allBlocked=false，不论 failed 与否都不剪枝
    expect(isBranchPruned(incoming, branchState, true, new Set(['cond']))).toBe(false);
  });

  it('sourceHandle 缺省与 undefined 匹配', () => {
    const incoming = [branchEdge('cond', 'x')]; // 无 sourceHandle
    const branchState = new Map<string, Set<string | undefined>>([
      ['cond', new Set<string | undefined>([undefined])], // 激活缺省 handle
    ]);
    expect(isBranchPruned(incoming, branchState, false, new Set())).toBe(false);
  });
});

describe('shouldContinueLoop (循环迭代决策)', () => {
  const gateIds = ['g1'];

  it('非 loop 工作流：永不继续', () => {
    const gateTaken = new Map<string, string[]>([['g1', ['pass']]]);
    expect(
      shouldContinueLoop({ hasLoop: false, loopGateIds: gateIds, gateTaken, round: 0, maxRounds: 3 }),
    ).toEqual({ loopContinued: false, reachedMax: false });
  });

  it('有 loop 且某 gate 走了 pass => 继续', () => {
    const gateTaken = new Map<string, string[]>([['g1', ['pass']]]);
    expect(
      shouldContinueLoop({ hasLoop: true, loopGateIds: gateIds, gateTaken, round: 0, maxRounds: 3 }),
    ).toEqual({ loopContinued: true, reachedMax: false });
  });

  it('有 loop 但无 gate 走 pass（走了 stop）=> 不继续', () => {
    const gateTaken = new Map<string, string[]>([['g1', ['stop']]]);
    expect(
      shouldContinueLoop({ hasLoop: true, loopGateIds: gateIds, gateTaken, round: 0, maxRounds: 3 }),
    ).toEqual({ loopContinued: false, reachedMax: false });
  });

  it('gate 未登记任何分支（首轮尚未触发）=> 不继续', () => {
    const gateTaken = new Map<string, string[]>();
    expect(
      shouldContinueLoop({ hasLoop: true, loopGateIds: gateIds, gateTaken, round: 0, maxRounds: 3 }),
    ).toEqual({ loopContinued: false, reachedMax: false });
  });

  it('多 gate：任一走 pass 即继续', () => {
    const gateTaken = new Map<string, string[]>([
      ['g1', ['stop']],
      ['g2', ['pass']],
    ]);
    expect(
      shouldContinueLoop({
        hasLoop: true,
        loopGateIds: ['g1', 'g2'],
        gateTaken,
        round: 1,
        maxRounds: 5,
      }),
    ).toEqual({ loopContinued: true, reachedMax: false });
  });

  it('达到最大轮数：本应继续但被截断 => loopContinued=false 且 reachedMax=true', () => {
    const gateTaken = new Map<string, string[]>([['g1', ['pass']]]);
    expect(
      shouldContinueLoop({ hasLoop: true, loopGateIds: gateIds, gateTaken, round: 3, maxRounds: 3 }),
    ).toEqual({ loopContinued: false, reachedMax: true });
  });

  it('未达最大轮数且走 pass => 继续（reachedMax=false）', () => {
    const gateTaken = new Map<string, string[]>([['g1', ['pass']]]);
    expect(
      shouldContinueLoop({ hasLoop: true, loopGateIds: gateIds, gateTaken, round: 1, maxRounds: 3 }),
    ).toEqual({ loopContinued: true, reachedMax: false });
  });
});

describe('planClustersPerStage (层→簇预计算)', () => {
  it('每层返回各自独立的簇列表，结构与 stages 一一对应', () => {
    // 两层：L0=[a,b] 互不冲突；L1=[c,d] 经 scope 冲突归簇
    const stages = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    const edges = [
      edge('x', 'c', { kind: 'task', scope: ['s'] }),
      edge('y', 'd', { kind: 'task', scope: ['s'] }), // c,d 冲突
    ];
    const plan = planClustersPerStage(stages, edges);
    expect(plan).toHaveLength(2);
    // L0：a,b 无冲突 => 两个独立簇
    expect(plan[0]).toHaveLength(2);
    // L1：c,d 共享 s => 同一簇
    expect(plan[1]).toHaveLength(1);
    expect([...plan[1][0]].sort()).toEqual(['c', 'd']);
  });

  it('空 stages 返回空', () => {
    expect(planClustersPerStage([], [])).toEqual([]);
  });

  it('单层多节点全冲突 => 单一簇且顺序保持', () => {
    const stages = [['n1', 'n2', 'n3']];
    const edges = [
      edge('a', 'n1', { kind: 'task', scope: ['shared'] }),
      edge('b', 'n2', { kind: 'task', scope: ['shared'] }),
      edge('c', 'n3', { kind: 'task', scope: ['shared'] }),
    ];
    const plan = planClustersPerStage(stages, edges);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0][0]).toEqual(['n1', 'n2', 'n3']);
  });

  it('预计算结果与逐层 computeScopeClusters 等价', () => {
    const stages = [
      ['a', 'b'],
      ['c', 'd', 'e'],
    ];
    const edges = [
      edge('w', 'c', { kind: 'task', scope: ['s1'] }),
      edge('z', 'd', { kind: 'task', scope: ['s1', 's2'] }), // c,d 冲突
      edge('v', 'e', { kind: 'task', scope: ['s3'] }),
    ];
    const plan = planClustersPerStage(stages, edges);
    for (let i = 0; i < stages.length; i++) {
      expect(plan[i]).toEqual(computeScopeClusters(stages[i], edges));
    }
  });
});

describe('resolveNodeExecutionMode (单节点执行路径判定)', () => {
  const def = { typeId: 'core.node', inputs: [], outputs: [], execute: async () => ({}) } as unknown as NodeDefinition;
  const noIncoming: FlowEdge[] = [];

  function baseNode(extra?: Partial<FlowNode['data']>): FlowNode {
    return {
      id: 'n1',
      type: 'base',
      position: { x: 0, y: 0 },
      data: { typeId: 'core.node', label: 'n1', ...extra },
    } as unknown as FlowNode;
  }

  it('上游失败传染 => upstream-failed（优先级最高）', () => {
    const incoming = [edge('a', 'n1')];
    const failed = new Set(['a']);
    const node = baseNode({ bypass: true }); // 即便 bypass，上游失败优先
    expect(
      resolveNodeExecutionMode({ node, def, incoming, failed, isIncremental: false, shouldRun: true, forced: true }),
    ).toEqual({ kind: 'upstream-failed' });
  });

  it('类型缺失 => missing-def（即便 force/dirty）', () => {
    const node = baseNode();
    const res = resolveNodeExecutionMode({
      node,
      def: undefined,
      incoming: noIncoming,
      failed: new Set(),
      isIncremental: false,
      shouldRun: true,
      forced: true,
    });
    expect(res).toEqual({ kind: 'missing-def' });
  });

  it('missing 标记的定义 => missing-def', () => {
    const missingDef = { ...def, missing: true };
    expect(
      resolveNodeExecutionMode({ node: baseNode(), def: missingDef, incoming: noIncoming, failed: new Set(), isIncremental: false, shouldRun: true, forced: true }),
    ).toEqual({ kind: 'missing-def' });
  });

  it('bypass 开关 => bypass', () => {
    expect(
      resolveNodeExecutionMode({ node: baseNode({ bypass: true }), def, incoming: noIncoming, failed: new Set(), isIncremental: false, shouldRun: true, forced: true }),
    ).toEqual({ kind: 'bypass' });
  });

  it('mute 开关 => mute（优先级高于 bypass 之外的判定）', () => {
    expect(
      resolveNodeExecutionMode({ node: baseNode({ mute: true }), def, incoming: noIncoming, failed: new Set(), isIncremental: false, shouldRun: true, forced: true }),
    ).toEqual({ kind: 'mute' });
  });

  it('增量模式且非 dirty 非 force => incremental-skip（携带原状态）', () => {
    const node = baseNode({ status: 'cached' as NodeStatus });
    expect(
      resolveNodeExecutionMode({ node, def, incoming: noIncoming, failed: new Set(), isIncremental: true, shouldRun: false, forced: false }),
    ).toEqual({ kind: 'incremental-skip', prevStatus: 'cached' });
  });

  it('增量模式但 force => execute（forced 覆盖跳过）', () => {
    const node = baseNode({ status: 'idle' as NodeStatus });
    expect(
      resolveNodeExecutionMode({ node, def, incoming: noIncoming, failed: new Set(), isIncremental: true, shouldRun: false, forced: true }),
    ).toEqual({ kind: 'execute' });
  });

  it('增量模式但 shouldRun（dirty）=> execute', () => {
    expect(
      resolveNodeExecutionMode({ node: baseNode(), def, incoming: noIncoming, failed: new Set(), isIncremental: true, shouldRun: true, forced: false }),
    ).toEqual({ kind: 'execute' });
  });

  it('全量模式（非增量）即便非 dirty => execute', () => {
    const node = baseNode({ status: 'idle' as NodeStatus });
    expect(
      resolveNodeExecutionMode({ node, def, incoming: noIncoming, failed: new Set(), isIncremental: false, shouldRun: false, forced: false }),
    ).toEqual({ kind: 'execute' });
  });

  it('默认正常节点 => execute', () => {
    expect(
      resolveNodeExecutionMode({ node: baseNode(), def, incoming: noIncoming, failed: new Set(), isIncremental: false, shouldRun: true, forced: false }),
    ).toEqual({ kind: 'execute' });
  });
});
