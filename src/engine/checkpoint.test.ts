/**
 * 检查点（Checkpoint）纯函数测试（阶段 C：可恢复执行）。
 *
 * 覆盖：buildCheckpoint 提取、applyCheckpoint 恢复语义（success 复用/error 标脏/其余重置）、
 * isRestorable 判定、fromRunRecord 兜底、pickCheckpoint。
 */
import { describe, it, expect } from 'vitest';
import {
  applyCheckpoint,
  buildCheckpoint,
  fromRunRecord,
  isRestorable,
  pickCheckpoint,
  type RunCheckpoint,
} from './checkpoint';
import type { FlowNode, RunRecord } from '../types';

function mkNode(id: string, patch: Partial<FlowNode['data']> = {}): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'x', label: id, params: {}, status: 'idle', dirty: true, ...patch },
  } as unknown as FlowNode;
}

describe('buildCheckpoint 构建', () => {
  it('忽略 idle 节点，保留有状态的节点', () => {
    const nodes = [
      mkNode('a', { status: 'success', outputs: { out: 1 }, durationMs: 10 }),
      mkNode('b', { status: 'error', error: 'boom' }),
      mkNode('c', { status: 'idle' }),
    ];
    const cp = buildCheckpoint(nodes, { wfId: 'wf1', runId: 3, status: 'error', startedAt: 100 });
    expect(Object.keys(cp.nodes)).toEqual(['a', 'b']);
    expect(cp.nodes['a'].outputs).toEqual({ out: 1 });
    expect(cp.nodes['b'].error).toBe('boom');
    expect(cp.wfId).toBe('wf1');
    expect(cp.runId).toBe(3);
    expect(cp.status).toBe('error');
  });
});

describe('applyCheckpoint 恢复', () => {
  const cp: RunCheckpoint = {
    wfId: 'wf1',
    runId: 1,
    status: 'error',
    startedAt: 0,
    endedAt: 100,
    nodes: {
      a: { status: 'success', outputs: { out: 'ok' }, durationMs: 5 },
      b: { status: 'error', error: 'boom', outputs: null },
      c: { status: 'skipped', outputs: null },
    },
  };

  it('success 节点：保留 outputs、不标脏、清除 error', () => {
    const out = applyCheckpoint(cp, [mkNode('a', { status: 'idle', dirty: true })]);
    const n = out[0]!;
    expect(n.data.status).toBe('success');
    expect(n.data.outputs).toEqual({ out: 'ok' });
    expect(n.data.dirty).toBe(false);
    expect(n.data.error).toBeUndefined();
  });

  it('cached 检查点状态也保持 cached 复用', () => {
    const cpCached: RunCheckpoint = {
      ...cp,
      nodes: { a: { status: 'cached', outputs: { out: 'x' } } },
    };
    const out = applyCheckpoint(cpCached, [mkNode('a')]);
    expect(out[0]!.data.status).toBe('cached');
    expect(out[0]!.data.dirty).toBe(false);
  });

  it('error 节点：保留 error、标脏待重跑', () => {
    const out = applyCheckpoint(cp, [mkNode('b')]);
    const n = out[0]!;
    expect(n.data.status).toBe('error');
    expect(n.data.error).toBe('boom');
    expect(n.data.dirty).toBe(true);
  });

  it('其余状态（skipped/idle/running）重置为 idle 并标脏', () => {
    const out = applyCheckpoint(cp, [mkNode('c')]);
    const n = out[0]!;
    expect(n.data.status).toBe('idle');
    expect(n.data.dirty).toBe(true);
    expect(n.data.outputs).toBeUndefined();
  });

  it('检查点未覆盖的节点保持原样', () => {
    const untouched = mkNode('z', { status: 'success', dirty: false });
    const out = applyCheckpoint(cp, [untouched]);
    expect(out[0]).toBe(untouched);
  });
});

describe('isRestorable 判定', () => {
  it('null/undefined 不可恢复', () => {
    expect(isRestorable(null)).toBe(false);
    expect(isRestorable(undefined)).toBe(false);
  });

  it('终态 error / aborted 可恢复', () => {
    expect(isRestorable({ status: 'error', nodes: {} } as RunCheckpoint)).toBe(true);
    expect(isRestorable({ status: 'aborted', nodes: {} } as RunCheckpoint)).toBe(true);
  });

  it('终态 success 但含 error 节点可恢复（skipFailed 场景）', () => {
    const cp: RunCheckpoint = {
      wfId: 'w', runId: 1, status: 'success', startedAt: 0, endedAt: 0,
      nodes: { a: { status: 'error', outputs: null } },
    };
    expect(isRestorable(cp)).toBe(true);
  });

  it('全部 success 不可恢复（已跑完）', () => {
    const cp: RunCheckpoint = {
      wfId: 'w', runId: 1, status: 'success', startedAt: 0, endedAt: 0,
      nodes: { a: { status: 'success', outputs: {} } },
    };
    expect(isRestorable(cp)).toBe(false);
  });
});

describe('fromRunRecord 兜底', () => {
  it('从历史记录重建检查点', () => {
    const rec: RunRecord = {
      id: 'run_1',
      name: 'wf',
      startedAt: new Date(10).toISOString(),
      endedAt: new Date(20).toISOString(),
      durationMs: 10,
      status: 'error',
      nodeCount: 1,
      nodes: [
        {
          id: 'a', label: 'a', typeId: 'x', status: 'error', outputs: null,
          error: 'boom', startedAt: 's', durationMs: 5, cost: null,
        },
      ],
    };
    const cp = fromRunRecord(rec, 'wf1');
    expect(cp.wfId).toBe('wf1');
    expect(cp.status).toBe('error');
    expect(cp.nodes['a'].error).toBe('boom');
    expect(cp.nodes['a'].durationMs).toBe(5);
  });
});

describe('pickCheckpoint', () => {
  it('按 wfId 取检查点，不存在返回 null', () => {
    const map = { wf1: buildCheckpoint([], { wfId: 'wf1', runId: 1, status: 'success', startedAt: 0 }) };
    expect(pickCheckpoint(map, 'wf1')).toBeTruthy();
    expect(pickCheckpoint(map, 'wf2')).toBeNull();
  });
});
