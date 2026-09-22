/**
 * H1c：循环控制辅助测试。
 *
 * 覆盖：prepareLoopRound（round>0 时注入 dirtySet/force + 清缓存 + 递增循环变量；round=0 不动）、
 * loopLogMessages（reachedMax 提示 / 无提示）。
 */
import { describe, it, expect } from 'vitest';
import { prepareLoopRound, loopLogMessages } from './runLoop';
import type { FlowNode } from '../types';

function mkNode(id: string, typeId: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId, label: id, params: {}, status: 'idle', dirty: true },
  } as unknown as FlowNode;
}

describe('prepareLoopRound 循环变量注入', () => {
  it('round=0 不注入（首轮直接执行）', () => {
    const dirty = new Set<string>();
    const force = new Set<string>();
    const vars: Record<string, number> = { i: 0 };
    prepareLoopRound({
      round: 0,
      loopBodies: new Map([['gate1', new Set(['a', 'b'])]]),
      loopVarOf: new Map([['gate1', 'i']]),
      nodeById: new Map([['a', mkNode('a', 'x')], ['b', mkNode('b', 'y')]]),
      dirtySet: dirty,
      force,
      loopVarsState: vars,
      strike: () => {},
    });
    expect(dirty.size).toBe(0);
    expect(force.size).toBe(0);
    expect(vars.i).toBe(0);
  });

  it('round>0 注入循环体节点与 loopGate 自身到 dirty/force 并清缓存、递增循环变量', () => {
    const dirty = new Set<string>();
    const force = new Set<string>();
    const vars: Record<string, number> = { i: 0 };
    const struck: string[] = [];
    prepareLoopRound({
      round: 2,
      loopBodies: new Map([['gate1', new Set(['a', 'b'])]]),
      loopVarOf: new Map([['gate1', 'i']]),
      nodeById: new Map([
        ['gate1', mkNode('gate1', 'flow.loopGate')],
        ['a', mkNode('a', 'type.a')],
        ['b', mkNode('b', 'type.b')],
      ]),
      dirtySet: dirty,
      force,
      loopVarsState: vars,
      strike: (nodeId, typeId) => struck.push(`${nodeId}:${typeId}`),
    });
    // loopGate 自身每轮必须强制重算（cacheKey 不含循环变量，命中缓存会吞掉分支上报导致循环误停）
    expect(dirty).toEqual(new Set(['gate1', 'a', 'b']));
    expect(force).toEqual(new Set(['gate1', 'a', 'b']));
    expect(struck).toEqual(['gate1:flow.loopGate', 'a:type.a', 'b:type.b']);
    expect(vars.i).toBe(2);
  });

  it('多个 loopGate 各自递增变量', () => {
    const vars: Record<string, number> = { i: 0, j: 0 };
    prepareLoopRound({
      round: 1,
      loopBodies: new Map([['g1', new Set(['a'])], ['g2', new Set(['c'])]]),
      loopVarOf: new Map([['g1', 'i'], ['g2', 'j']]),
      nodeById: new Map([['a', mkNode('a', 'x')], ['c', mkNode('c', 'z')]]),
      dirtySet: new Set(),
      force: new Set(),
      loopVarsState: vars,
      strike: () => {},
    });
    expect(vars.i).toBe(1);
    expect(vars.j).toBe(1);
  });
});

describe('loopLogMessages', () => {
  it('reachedMax 输出强制结束提示', () => {
    expect(loopLogMessages({ round: 5, maxRounds: 5, reachedMax: true })).toEqual([
      '已达到最大循环轮数 5，强制结束循环',
    ]);
  });

  it('未达最大轮数不输出', () => {
    expect(loopLogMessages({ round: 1, maxRounds: 5, reachedMax: false })).toEqual([]);
  });
});
