/**
 * SandboxManager.test.ts — H2 PoC P0：沙箱管理器协议链路单测。
 *
 * 用 fake worker 模拟 worker 端行为（不走真实 Web Worker，jsdom 无原生 Worker）：
 * - 加载（load-plugin → ready）
 * - 执行（execute → execute:result / execute:error）
 * - 能力代理（capability:request → 宿主 responder → capability:response）
 * - 超时（timeoutMs 到期 → terminate + reject）
 * - 崩溃（onerror → reject + 重建）
 * - 取消（signal abort → 转发 abort 消息）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxManager, execContextResponder } from './SandboxManager';
import type { WorkerLike } from './SandboxManager';
import type { HostToWorker, WorkerToHost } from './protocol';

// jsdom 环境缺 URL.createObjectURL/revokeObjectURL（Node 22 也无全局 Worker），
// 打桩让 createRuntimeUrl 能生成伪 URL、worker 工厂照常被调用。
if (typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:fake-${counter++}`;
}
if (typeof URL.revokeObjectURL !== 'function') {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {
    /* noop */
  };
}

/** 可编程 fake worker：记录宿主发来的消息，测试手动触发 worker 回包 */
class FakeWorker implements WorkerLike {
  sent: HostToWorker[] = [];
  terminated = false;
  onmessage: ((ev: { data: WorkerToHost }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  /** 测试辅助：宿主向 worker 发消息 */
  postMessage(msg: HostToWorker): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** 测试辅助：模拟 worker 回复 */
  reply(m: WorkerToHost): void {
    this.onmessage?.({ data: m });
  }
  /** 测试辅助：模拟 worker 崩溃 */
  crash(msg = 'boom'): void {
    this.onerror?.({ message: msg });
  }
  lastExec(): Extract<HostToWorker, { kind: 'execute' }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<HostToWorker, { kind: 'execute' }> => m.kind === 'execute');
  }
}

function makeFakeFactory(): { factory: (url: string) => WorkerLike; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const factory = (_url: string): WorkerLike => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  return { factory, workers };
}

/** 最小 ExecContext stub */
function stubCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: vi.fn().mockResolvedValue('llm-reply'),
    storage: { get: vi.fn().mockResolvedValue('stored'), set: vi.fn().mockResolvedValue(undefined) },
    reportCost: vi.fn(),
    setPartial: vi.fn(),
    setBranches: vi.fn(),
    vars: {},
    costLog: [],
    signal: new AbortController().signal,
    assets: [],
    addAsset: vi.fn(),
  } as never;
}

const ENTRY = `export default { executors: { 'test.add': async (i,p,c) => ({ out: Number(i.a) + Number(i.b) }) } };`;

describe('SandboxManager 沙箱执行链路', () => {
  let f: ReturnType<typeof makeFakeFactory>;
  let mgr: SandboxManager;

  beforeEach(() => {
    f = makeFakeFactory();
    mgr = new SandboxManager({ workerFactory: f.factory, timeoutMs: 1000 });
  });

  it('加载 + 执行：load-plugin → ready → execute → result', async () => {
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: { a: 2, b: 3 },
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    // worker 创建后收到 load-plugin（ensureSlot 异步，等待工厂被调用）
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    expect(w.sent[0]).toMatchObject({ kind: 'load-plugin', pluginId: 'p1' });
    // 模拟 worker 就绪
    w.reply({ kind: 'ready', pluginId: 'p1' });
    // 等待 execute 消息发出
    await vi.waitFor(() => {
      expect(w.lastExec()).toBeTruthy();
    });
    // 模拟 worker 返回结果
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 5 } });
    await expect(p).resolves.toEqual({ out: 5 });
  });

  it('execute:error → reject', async () => {
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    w.reply({ kind: 'execute:error', id: w.lastExec()!.id, error: 'add 失败' });
    await expect(p).rejects.toThrow('add 失败');
  });

  it('超时：到期 terminate + reject，并重建（下次 execute 用新 worker）', async () => {
    const fast = new SandboxManager({ workerFactory: f.factory, timeoutMs: 30 });
    const p = fast.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    // 不回复 execute → 超时
    await expect(p).rejects.toThrow(/超时/);
    expect(w.terminated).toBe(true);
    // 重建：下一次 execute 产生新 worker（给足超时，避免 30ms 内握手来不及）
    const p2 = fast.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
      timeoutMs: 500,
    });
    const w2 = f.workers[1];
    w2.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w2.lastExec()).toBeTruthy());
    w2.reply({ kind: 'execute:result', id: w2.lastExec()!.id, outputs: { out: 1 } });
    await expect(p2).resolves.toEqual({ out: 1 });
  });

  it('worker 崩溃（onerror）→ reject + 销毁槽位（下次自动重建）', async () => {
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    w.crash('worker died');
    await expect(p).rejects.toThrow(/沙箱崩溃/);
    expect(w.terminated).toBe(true);
    // 重建
    const p2 = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    const w2 = f.workers[1];
    w2.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w2.lastExec()).toBeTruthy());
    w2.reply({ kind: 'execute:result', id: w2.lastExec()!.id, outputs: { out: 9 } });
    await expect(p2).resolves.toEqual({ out: 9 });
  });

  it('能力代理：capability:request → 宿主 responder → capability:response', async () => {
    const ctx = stubCtx();
    mgr.registerResponder('p1', execContextResponder(ctx));
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: { a: 1, b: 1 },
      params: {},
      capability: 'io',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    // 模拟 worker 发起能力请求（llm）
    w.reply({
      kind: 'capability:request',
      id: 'cap1',
      method: 'llm',
      args: ['agentA', [{ role: 'user', content: 'hi' }], undefined, undefined],
      nodeId: 'n1',
    });
    // 宿主应回包
    await vi.waitFor(() => {
      const resp = w.sent.find((m) => m.kind === 'capability:response' && m.id === 'cap1');
      expect(resp).toBeTruthy();
    });
    const resp = w.sent.find((m) => m.kind === 'capability:response' && m.id === 'cap1');
    expect(resp).toMatchObject({ kind: 'capability:response', ok: true, value: 'llm-reply' });
    expect(ctx.llm).toHaveBeenCalledWith('agentA', [{ role: 'user', content: 'hi' }], undefined, undefined, undefined);
    // 收尾
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 2 } });
    await expect(p).resolves.toEqual({ out: 2 });
    mgr.unregisterResponder('p1');
  });

  it('能力代理：未注册 responder → 返回错误回包（不崩溃）', async () => {
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'io',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    w.reply({
      kind: 'capability:request',
      id: 'capX',
      method: 'llm',
      args: ['a', []],
      nodeId: 'n1',
    });
    await vi.waitFor(() => {
      expect(w.sent.some((m) => m.kind === 'capability:response' && m.id === 'capX' && m.ok === false)).toBe(true);
    });
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 1 } });
    await expect(p).resolves.toEqual({ out: 1 });
  });

  it('取消：signal abort → 转发 abort 消息给 worker', async () => {
    const ac = new AbortController();
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    ac.abort();
    await vi.waitFor(() => {
      expect(w.sent.some((m) => m.kind === 'abort')).toBe(true);
    });
    // worker 收到 abort 后若执行中止 → 回 error；PoC 中由 worker 内 ctx.signal 处理
    const abortMsg = w.sent.find((m) => m.kind === 'abort') as Extract<HostToWorker, { kind: 'abort' }>;
    expect(abortMsg.runId).toBeTruthy();
    // 正常收尾
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 1 } });
    await expect(p).resolves.toEqual({ out: 1 });
  });

  it('并发限制：同 worker 二次 execute 直接 reject', async () => {
    const p1 = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    // 同 worker 并发第二次
    const p2 = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    });
    await expect(p2).rejects.toThrow(/并发/);
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 1 } });
    await expect(p1).resolves.toEqual({ out: 1 });
  });

  it('terminateAll：清空全部 worker 槽位', async () => {
    const p = mgr.execute('p1', ENTRY, {
      typeId: 'test.add',
      inputs: {},
      params: {},
      capability: 'compute',
      nodeId: 'n1',
      vars: {},
      costLog: [],
    }).catch(() => {});
    await vi.waitFor(() => expect(f.workers.length).toBeGreaterThan(0));
    const w = f.workers[0];
    w.reply({ kind: 'ready', pluginId: 'p1' });
    await vi.waitFor(() => expect(w.lastExec()).toBeTruthy());
    w.reply({ kind: 'execute:result', id: w.lastExec()!.id, outputs: { out: 1 } });
    await p;
    expect(mgr.activeCount).toBe(1);
    mgr.terminateAll();
    expect(mgr.activeCount).toBe(0);
    expect(f.workers[0].terminated).toBe(true);
  });
});
