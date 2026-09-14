import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { topoLayers, wouldCreateCycle, topoStages } from './topoSort';

describe('topoLayers', () => {
  it('线性链分成单节点层', () => {
    const r = topoLayers(['a', 'b', 'c'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    expect(r.layers).toEqual([['a'], ['b'], ['c']]);
    expect(r.cyclic).toEqual([]);
  });

  it('同层无依赖的节点并行', () => {
    const r = topoLayers(['a', 'b', 'c'], [
      { source: 'a', target: 'c' },
      { source: 'b', target: 'c' },
    ]);
    expect(r.layers).toEqual([['a', 'b'], ['c']]);
    expect(r.cyclic).toEqual([]);
  });

  it('孤立节点放进第 0 层', () => {
    const r = topoLayers(['a', 'b'], [{ source: 'a', target: 'b' }]);
    expect(r.layers[0]).toContain('a');
  });

  it('引用不存在节点的悬空边被忽略', () => {
    const r = topoLayers(['a', 'b'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'ghost' },
    ]);
    expect(r.cyclic).toEqual([]);
    expect(r.layers.flat()).toEqual(['a', 'b']);
  });

  it('成环的节点进入 cyclic', () => {
    const r = topoLayers(['a', 'b', 'c'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ]);
    expect(r.cyclic.sort()).toEqual(['a', 'b', 'c']);
    expect(r.layers).toEqual([]);
  });
});

describe('wouldCreateCycle', () => {
  it('自环直接成环', () => {
    expect(wouldCreateCycle('a', 'a', [])).toBe(true);
  });

  it('直接回边成环', () => {
    const edges = [{ source: 'a', target: 'b' }];
    expect(wouldCreateCycle('b', 'a', edges)).toBe(true);
  });

  it('经中间节点的环被检出', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    expect(wouldCreateCycle('c', 'a', edges)).toBe(true);
  });

  it('无环图加边不成环', () => {
    const edges = [{ source: 'a', target: 'b' }];
    expect(wouldCreateCycle('b', 'c', edges)).toBe(false);
  });

  it('默认忽略 control 边，允许条件→循环体→回指条件 伪环', () => {
    const edges = [
      { source: 'cond', target: 'body', data: { kind: 'control' } },
      { source: 'body', target: 'cond', data: { kind: 'control' } },
    ];
    expect(wouldCreateCycle('cond', 'body', edges)).toBe(false);
  });

  it('ignoreControl=false 时 control 边也参与成环判定', () => {
    const edges = [
      { source: 'cond', target: 'body', data: { kind: 'control' } },
      { source: 'body', target: 'cond', data: { kind: 'control' } },
    ];
    expect(wouldCreateCycle('cond', 'body', edges, false)).toBe(true);
  });
});

describe('topoStages', () => {
  it('纯 data 边按 Kahn 分层', () => {
    const r = topoStages(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
      [],
    );
    expect(r.stages).toEqual([['a'], ['b'], ['c']]);
    expect(r.cyclic).toEqual([]);
  });

  it('data 边成环时返回 cyclic', () => {
    const r = topoStages(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
      [],
    );
    expect(r.cyclic.sort()).toEqual(['a', 'b']);
  });

  it('control 边不破坏 data 分层结果（正向 control 边为 no-op 但安全）', () => {
    // a→b (data)，独立链 c→d (data)，加 control 边 b→c。
    // 源码语义：c 在 data 拓扑里位于 stage 0（早于 b 的 stage 1），
    // 该 control 边被视为「回流/断点」被忽略，不抬高、不死循环。
    const r = topoStages(
      ['a', 'b', 'c', 'd'],
      [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
      [{ source: 'b', target: 'c' }],
    );
    // data 分层保持：a/c 在第 0 层，b/d 在第 1 层
    expect(r.stages[0]).toEqual(expect.arrayContaining(['a', 'c']));
    expect(r.stages[1]).toEqual(expect.arrayContaining(['b', 'd']));
    expect(r.cyclic).toEqual([]);
  });

  it('正向 control 边（to 的 data-stage 晚于 from）保持数据依赖顺序', () => {
    // a→b→c (data)；control 边 a→c 要求 c 晚于 a（data 已满足）。
    // 验证 control 边不会把 c 错误地前移或破坏分层。
    const r = topoStages(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
      [{ source: 'a', target: 'c' }],
    );
    // 顺序应为 a(0) → b(1) → c(2)
    expect(r.stages[0]).toEqual(['a']);
    expect(r.stages[1]).toEqual(['b']);
    expect(r.stages[2]).toEqual(['c']);
    expect(r.cyclic).toEqual([]);
  });

  it('回流 control 边（target 已在 source 之前）不互相追逐死循环', () => {
    // architect.goal → council (data); council.backflow → architect (control, 回流)
    const r = topoStages(
      ['architect', 'council'],
      [{ source: 'architect', target: 'council' }],
      [{ source: 'council', target: 'architect' }],
    );
    expect(r.stages.length).toBeGreaterThan(0);
    expect(r.cyclic).toEqual([]);
  });

  it('loopGate 的 data 回流不会让 stage 计算无限增长', () => {
    const script = [
      "import { topoStages } from './src/engine/topoSort.ts';",
      "const result = topoStages(['gate', 'body'], [{ source: 'body', target: 'gate' }], [{ source: 'gate', target: 'body' }], new Set(['gate']));",
      'console.log(JSON.stringify(result));',
    ].join('\n');
    const output = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 2_000 },
    );
    const result = JSON.parse(output) as { stages: string[][]; cyclic: string[] };
    expect(result.cyclic).toEqual([]);
    expect(result.stages.flat()).toEqual(['gate', 'body']);
  });
});
