/**
 * 实时接管注册表单测（阶段 D）。
 *
 * 覆盖：requestIntervention 挂起+事件、resolve 放行（resolved）、reject 放行（cancelled）、
 * 重复请求取代、cancelInterventionsForRun 按运行清理、reset 测试隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cancelInterventionsForRun,
  getPendingInterventions,
  hasPendingInterventions,
  rejectIntervention,
  requestIntervention,
  resetInterventions,
  resolveIntervention,
} from './intervention';
import { getRunBus, resetRunBus, type RunEvent } from './runEvents';

const req = {
  wfId: 'wfA',
  runId: 7,
  nodeId: 'n1',
  label: '节点一',
  typeId: 'ai.chat',
  message: '需要你审阅这个草稿',
  defaultResult: 'draft',
};

describe('requestIntervention 挂起与放行', () => {
  beforeEach(() => {
    resetRunBus();
    resetInterventions();
  });

  it('请求时 emit node.intervene 事件，resolve 放行出 resolved', async () => {
    const events: RunEvent[] = [];
    getRunBus().subscribe((e) => events.push(e));

    const p = requestIntervention(req);
    // 事件应带 wfId/runId/nodeId 三元组 + message 负载
    const ev = events.find((e) => e.kind === 'node.intervene');
    expect(ev).toBeTruthy();
    expect(ev!.wfId).toBe('wfA');
    expect(ev!.runId).toBe(7);
    expect(ev!.nodeId).toBe('n1');
    expect(ev!.payload?.message).toBe('需要你审阅这个草稿');
    expect(hasPendingInterventions()).toBe(true);
    expect(getPendingInterventions()[0]?.defaultResult).toBe('draft');

    const done = resolveIntervention('n1', '用户改好的结果');
    expect(done).toBe(true);
    const r = await p;
    expect(r).toEqual({ kind: 'resolved', result: '用户改好的结果' });
    expect(hasPendingInterventions()).toBe(false);
  });

  it('reject 放行出 cancelled（带错误信息）', async () => {
    const p = requestIntervention(req);
    rejectIntervention('n1', '人工取消');
    const r = await p;
    expect(r).toEqual({ kind: 'cancelled', error: '人工取消' });
  });

  it('对不存在的 nodeId resolve/reject 返回 false', () => {
    expect(resolveIntervention('ghost', 'x')).toBe(false);
    expect(rejectIntervention('ghost')).toBe(false);
  });

  it('重复请求取代旧请求：旧 Promise 被 reject，新请求保留', async () => {
    const p1 = requestIntervention(req);
    const p2 = requestIntervention({ ...req, message: '第二次请求' });
    await expect(p1).rejects.toThrow(/取代/);
    expect(getPendingInterventions().length).toBe(1);
    resolveIntervention('n1', 'ok');
    const r2 = await p2;
    expect(r2).toEqual({ kind: 'resolved', result: 'ok' });
  });

  it('cancelInterventionsForRun 只取消指定运行，以 cancelled 正常放行', async () => {
    const pA = requestIntervention(req);
    const pB = requestIntervention({ ...req, wfId: 'wfB', nodeId: 'm1' });
    cancelInterventionsForRun('wfA', 7);
    const rA = await pA;
    expect(rA.kind).toBe('cancelled');
    // wfB 的请求仍在
    expect(getPendingInterventions().length).toBe(1);
    resolveIntervention('m1', 'ok');
    const rB = await pB;
    expect(rB).toEqual({ kind: 'resolved', result: 'ok' });
  });

  it('reset 清空全部 pending 并 reject', async () => {
    const p = requestIntervention(req);
    resetInterventions();
    await expect(p).rejects.toThrow(/重置/);
    expect(hasPendingInterventions()).toBe(false);
  });
});
