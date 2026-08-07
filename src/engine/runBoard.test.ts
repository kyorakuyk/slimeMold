/**
 * runBoard 纯归约逻辑测试（A2：JobBoard 消费事件流的可测核心）。
 *
 * 覆盖：run.created 重置、node 事件归约、进度更新、终态停跑、wfId 过滤、replay。
 */
import { describe, it, expect } from 'vitest';
import { applyRunEvent, initialBoardState, replayBoardState } from './runBoard';
import type { RunEvent } from './runEvents';

function ev(partial: Partial<RunEvent> & Pick<RunEvent, 'kind' | 'wfId' | 'runId'>): RunEvent {
  return { nodeId: null, at: 0, ...partial };
}

describe('applyRunEvent 归约', () => {
  it('run.created 重置快照并记录 nodeCount / runId', () => {
    const st = applyRunEvent(initialBoardState('wfA'), ev({ kind: 'run.created', wfId: 'wfA', runId: 5, payload: { nodeCount: 3 } }));
    expect(st.runId).toBe(5);
    expect(st.nodeCount).toBe(3);
    expect(st.running).toBe(false);
    expect(st.nodes).toEqual({});
  });

  it('run.started 置 running，node 事件按序归约成最终状态', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'run.started', wfId: 'wfA', runId: 1 }));
    expect(st.running).toBe(true);

    st = applyRunEvent(st, ev({ kind: 'node.started', wfId: 'wfA', runId: 1, nodeId: 'n1', payload: { label: 'A', typeId: 'input.text' } }));
    expect(st.nodes['n1'].status).toBe('running');

    st = applyRunEvent(st, ev({ kind: 'node.completed', wfId: 'wfA', runId: 1, nodeId: 'n1', payload: { status: 'success', durationMs: 12, label: 'A' } }));
    expect(st.nodes['n1'].status).toBe('success');
    expect(st.nodes['n1'].durationMs).toBe(12);
  });

  it('node.failed 记录 error 与 durationMs', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'node.started', wfId: 'wfA', runId: 1, nodeId: 'x' }));
    st = applyRunEvent(st, ev({ kind: 'node.failed', wfId: 'wfA', runId: 1, nodeId: 'x', payload: { error: 'boom', durationMs: 30 } }));
    expect(st.nodes['x'].status).toBe('error');
    expect(st.nodes['x'].error).toBe('boom');
    expect(st.nodes['x'].durationMs).toBe(30);
  });

  it('node.skipped：普通剪枝为 skipped，incremental-skip 保留 payload.status', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'node.skipped', wfId: 'wfA', runId: 1, nodeId: 'p', payload: { reason: 'pruned' } }));
    expect(st.nodes['p'].status).toBe('skipped');

    st = applyRunEvent(st, ev({ kind: 'node.skipped', wfId: 'wfA', runId: 1, nodeId: 'c', payload: { status: 'cached', reason: 'incremental-skip' } }));
    expect(st.nodes['c'].status).toBe('cached');
  });

  it('run.progress 更新分层/轮次进度', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'run.progress', wfId: 'wfA', runId: 1, payload: { layer: 2, totalLayers: 4, round: 1, totalRounds: 3 } }));
    expect(st.progress).toEqual({ layer: 2, totalLayers: 4, round: 1, totalRounds: 3 });
  });

  it('终态事件置 running=false', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'run.started', wfId: 'wfA', runId: 1 }));
    st = applyRunEvent(st, ev({ kind: 'run.completed', wfId: 'wfA', runId: 1, payload: { status: 'success' } }));
    expect(st.running).toBe(false);
  });

  it('不同 wfId 的事件被忽略', () => {
    let st = initialBoardState('wfA');
    st = applyRunEvent(st, ev({ kind: 'run.created', wfId: 'wfB', runId: 1 }));
    expect(st.runId).toBeNull();
    st = applyRunEvent(st, ev({ kind: 'node.started', wfId: 'wfB', runId: 1, nodeId: 'n' }));
    expect(st.nodes).toEqual({});
  });
});

describe('replayBoardState 挂载即同步', () => {
  it('从最近一次 run.created 回放，忽略更早运行', () => {
    const events: RunEvent[] = [
      ev({ kind: 'run.created', wfId: 'wfA', runId: 1 }),
      ev({ kind: 'run.started', wfId: 'wfA', runId: 1 }),
      ev({ kind: 'node.started', wfId: 'wfA', runId: 1, nodeId: 'a' }),
      ev({ kind: 'node.completed', wfId: 'wfA', runId: 1, nodeId: 'a', payload: { status: 'success' } }),
      ev({ kind: 'run.completed', wfId: 'wfA', runId: 1 }),
      ev({ kind: 'run.created', wfId: 'wfA', runId: 2 }),
      ev({ kind: 'run.started', wfId: 'wfA', runId: 2 }),
      ev({ kind: 'node.started', wfId: 'wfA', runId: 2, nodeId: 'b' }),
    ];
    const st = replayBoardState('wfA', events);
    expect(st.runId).toBe(2);
    expect(st.running).toBe(true);
    expect(st.nodes['b']).toBeTruthy();
    expect(st.nodes['a']).toBeUndefined(); // 第一次运行的节点已清空
  });

  it('无事件时返回空快照', () => {
    const st = replayBoardState('wfA', []);
    expect(st.runId).toBeNull();
    expect(st.running).toBe(false);
  });
});
