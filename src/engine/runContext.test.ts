import { describe, it, expect, beforeEach } from 'vitest';
import { createEventBus, emitRun, emitNode, EventBus } from './runEvents';
import { derivePolicy } from './runContext';

describe('runEvents 事件总线', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = createEventBus({ bufferSize: 50 });
  });

  it('subscribe 能收到 emit 的事件，并自动填充 at 墙钟时刻', () => {
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.kind));
    bus.emit({ kind: 'run.created', wfId: 'wfA', runId: 1, nodeId: null });
    expect(got).toEqual(['run.created']);
    off();
    bus.emit({ kind: 'run.started', wfId: 'wfA', runId: 1, nodeId: null });
    // 取消订阅后不再收到
    expect(got).toEqual(['run.created']);
  });

  it('emitRun / emitNode 便捷构造器自动携带 wfId+runId+nodeId', () => {
    const events: { kind: string; wfId: string; runId: number; nodeId: string | null }[] = [];
    bus.subscribe((e) => events.push({ kind: e.kind, wfId: e.wfId, runId: e.runId, nodeId: e.nodeId }));
    emitRun(bus, 'run.started', { wfId: 'wfA', runId: 7 });
    emitNode(bus, 'node.completed', { wfId: 'wfA', runId: 7 }, 'n1', { status: 'success' });
    expect(events[0]).toMatchObject({ kind: 'run.started', wfId: 'wfA', runId: 7, nodeId: null });
    expect(events[1]).toMatchObject({ kind: 'node.completed', wfId: 'wfA', runId: 7, nodeId: 'n1' });
  });

  it('history 可按 wfId/runId 过滤历史事件', () => {
    emitRun(bus, 'run.created', { wfId: 'wfA', runId: 1 });
    emitRun(bus, 'run.created', { wfId: 'wfB', runId: 1 });
    emitNode(bus, 'node.started', { wfId: 'wfA', runId: 1 }, 'n1');
    expect(bus.history('wfA').length).toBe(2);
    expect(bus.history('wfA', 1).length).toBe(2);
    expect(bus.history('wfB').length).toBe(1);
    expect(bus.history('wfA', 99).length).toBe(0);
  });

  it('缓冲区按 bufferSize FIFO 丢弃最旧事件', () => {
    const tiny = createEventBus({ bufferSize: 3 });
    for (let i = 0; i < 5; i++) tiny.emit({ kind: 'run.created', wfId: 'wfA', runId: 1, nodeId: null });
    expect(tiny.history().length).toBe(3);
  });

  it('clear 清空缓冲区与订阅', () => {
    let count = 0;
    bus.subscribe(() => count++);
    bus.emit({ kind: 'run.created', wfId: 'wfA', runId: 1, nodeId: null });
    expect(count).toBe(1);
    expect(bus.history().length).toBe(1); // 清空前缓冲含 1 条
    bus.clear();
    // 清空后缓冲立即为空
    expect(bus.history().length).toBe(0);
    bus.emit({ kind: 'run.started', wfId: 'wfA', runId: 1, nodeId: null });
    expect(count).toBe(1); // 订阅已被清除，不再收到新事件
    expect(bus.history().length).toBe(1); // 但新事件仍进入缓冲（缓冲与订阅独立）
  });
});

describe('derivePolicy 由 RunOptions 归一', () => {
  it('缺省值全部取 false / 空数组 / 默认并发', () => {
    const p = derivePolicy({} as never, { maxConcurrency: 4 });
    expect(p).toEqual({
      incremental: false,
      retryFailed: false,
      skipFailed: false,
      forceRerun: false,
      isolated: false,
      stopAfterNodes: [],
      forceNodes: [],
      sandbox: false,
      sandboxMode: 'copy',
      maxConcurrency: 4,
      maxLoopsOverride: 0,
    });
  });

  it('显式字段覆盖缺省', () => {
    const p = derivePolicy(
      { incremental: true, sandbox: true, sandboxMode: 'gitworktree', maxConcurrency: 2, stopAfterNodes: ['n9'] } as never,
      { maxConcurrency: 4 },
    );
    expect(p.incremental).toBe(true);
    expect(p.sandbox).toBe(true);
    expect(p.sandboxMode).toBe('gitworktree');
    expect(p.maxConcurrency).toBe(2);
    expect(p.stopAfterNodes).toEqual(['n9']);
  });
});
