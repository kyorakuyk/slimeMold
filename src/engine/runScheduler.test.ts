/**
 * H1b：runScheduler 直接测试（Codex 建议补 runScheduler 直接测试）。
 *
 * 覆盖：runStage 簇并发执行顺序（簇内串行、簇间并行）、进度事件、
 * fail-fast 中止（层粒度）、abort/非当前代次提前返回、层结束检查点快照回调。
 */
import { describe, it, expect } from 'vitest';
import { runStage, type RunStageInput } from './runScheduler';
import type { RunContext } from './runContext';
import type { ExecutionRuntime } from './runtime';

function fakeRuntime(): ExecutionRuntime {
  return {
    addLog: () => {},
    setRunProgress: () => {},
    pushRunHistory: () => {},
    setCostLog: () => {},
    resetUsage: () => {},
    setNodeStatus: () => {},
    addAsset: () => {},
    setEdges: () => {},
  } as unknown as ExecutionRuntime;
}

function baseInput(overrides: Partial<RunStageInput>): RunStageInput {
  return {
    layer: ['a', 'b'],
    layerIndex: 0,
    totalLayers: 2,
    round: 0,
    totalRounds: 1,
    clusters: [['a', 'b']],
    failed: new Set(),
    signal: new AbortController().signal,
    isCurrent: () => true,
    failFast: false,
    abort: () => {},
    wfId: 'wfA',
    runCtx: { wfId: 'wfA', runId: 1 } as RunContext,
    rt: fakeRuntime(),
    scheduleCheckpoint: () => {},
    executeNode: async () => {},
    ...overrides,
  };
}

describe('runStage 调度', () => {
  it('单簇：按列表顺序串行执行每个节点', async () => {
    const executed: string[] = [];
    await runStage(baseInput({ executeNode: async (id) => { executed.push(id); } }));
    expect(executed).toEqual(['a', 'b']);
  });

  it('多簇：簇间并行、簇内串行（所有节点都执行到）', async () => {
    const executed: string[] = [];
    await runStage(baseInput({
      clusters: [['a', 'b'], ['c']],
      executeNode: async (id) => { executed.push(id); },
    }));
    expect(executed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('发送 run.progress 进度事件（含层/轮信息）', async () => {
    const events: Array<Record<string, unknown>> = [];
    await runStage(baseInput({
      layerIndex: 1,
      totalLayers: 3,
      round: 2,
      totalRounds: 5,
      onProgress: (p) => events.push({ ...p }),
    }));
    expect(events).toEqual([{ layer: 2, totalLayers: 3, round: 3, totalRounds: 5 }]);
  });

  it('fail-fast：层结束后若有失败则 abort（层粒度语义）', async () => {
    const failed = new Set<string>();
    let aborted = false;
    await runStage(baseInput({
      failed,
      failFast: true,
      abort: () => { aborted = true; },
      executeNode: async (id) => { if (id === 'a') failed.add('a'); },
    }));
    // 原语义：fail-fast 是「层间」判定——当前层全部执行完才 abort（不是节点间中断）
    expect(aborted).toBe(true);
  });

  it('fail-fast=false 时层结束不 abort', async () => {
    const failed = new Set<string>();
    let aborted = false;
    await runStage(baseInput({
      failed,
      failFast: false,
      abort: () => { aborted = true; },
      executeNode: async (id) => { if (id === 'a') failed.add('a'); },
    }));
    expect(aborted).toBe(false);
  });

  it('signal aborted：不执行任何节点', async () => {
    const executed: string[] = [];
    const ac = new AbortController();
    ac.abort();
    await runStage(baseInput({ signal: ac.signal, executeNode: async (id) => { executed.push(id); } }));
    expect(executed).toEqual([]);
  });

  it('非当前代次：提前返回不执行', async () => {
    const executed: string[] = [];
    await runStage(baseInput({ isCurrent: () => false, executeNode: async (id) => { executed.push(id); } }));
    expect(executed).toEqual([]);
  });

  it('层结束触发 scheduleCheckpoint', async () => {
    let calls = 0;
    await runStage(baseInput({ scheduleCheckpoint: () => { calls += 1; } }));
    expect(calls).toBe(1);
  });
});
