import { describe, it, expect, vi, beforeEach } from 'vitest';

// 在导入 runtime 之前，mock store 模块，让 createStoreRuntime 的默认实现委托到可控的假对象
const fakeStore = {
  addLog: vi.fn(),
  setRunProgress: vi.fn(),
  pushRunHistory: vi.fn(),
  setCostLog: vi.fn(),
  resetUsage: vi.fn(),
  setNodeStatus: vi.fn(),
  addAsset: vi.fn(),
  setEdges: vi.fn(),
};
vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: {
    getState: () => fakeStore,
  },
}));

import { createStoreRuntime } from './runtime';

describe('createStoreRuntime (执行引擎解耦接缝)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('addLog 转发到 store.addLog', () => {
    const rt = createStoreRuntime('wf1');
    rt.addLog('warn', 'hi');
    expect(fakeStore.addLog).toHaveBeenCalledWith('warn', 'hi');
  });

  it('setRunProgress 转发到 store.setRunProgress（含 wfId）', () => {
    const rt = createStoreRuntime('wf1');
    rt.setRunProgress({ active: true, layer: 1 }, 'wf9');
    expect(fakeStore.setRunProgress).toHaveBeenCalledWith({ active: true, layer: 1 }, 'wf9');
  });

  it('pushRunHistory 转发到 store.pushRunHistory', () => {
    const rt = createStoreRuntime('wf1');
    const rec = { id: 'r1' } as never;
    rt.pushRunHistory(rec);
    expect(fakeStore.pushRunHistory).toHaveBeenCalledWith(rec);
  });

  it('setCostLog 转发到 store.setCostLog', () => {
    const rt = createStoreRuntime('wf1');
    const log = [{ nodeId: 'n1' }] as never;
    rt.setCostLog(log);
    expect(fakeStore.setCostLog).toHaveBeenCalledWith(log);
  });

  it('resetUsage 转发到 store.resetUsage', () => {
    const rt = createStoreRuntime('wf1');
    rt.resetUsage();
    expect(fakeStore.resetUsage).toHaveBeenCalledOnce();
  });

  it('setNodeStatus 转发到 store.setNodeStatus（含 patch/wfId）', () => {
    const rt = createStoreRuntime('wf1');
    rt.setNodeStatus('n1', 'success', { outputs: { x: 1 } }, 'wf9');
    expect(fakeStore.setNodeStatus).toHaveBeenCalledWith('n1', 'success', { outputs: { x: 1 } }, 'wf9');
  });

  it('addAsset 转发到 store.addAsset', () => {
    const rt = createStoreRuntime('wf1');
    const meta = { id: 'a1', name: 'f', mime: 'text/plain', path: 'p', scope: 'project' } as never;
    rt.addAsset(meta);
    expect(fakeStore.addAsset).toHaveBeenCalledWith(meta);
  });

  it('setEdges 转发到 store.setEdges', () => {
    const rt = createStoreRuntime('wf1');
    const updater = (e: unknown[]) => e;
    rt.setEdges(updater as never);
    expect(fakeStore.setEdges).toHaveBeenCalledWith(updater);
  });

  it('每个 wfId 都返回完整接口（方法齐备）', () => {
    const rt = createStoreRuntime('any-wf');
    expect(typeof rt.addLog).toBe('function');
    expect(typeof rt.setRunProgress).toBe('function');
    expect(typeof rt.pushRunHistory).toBe('function');
    expect(typeof rt.setCostLog).toBe('function');
    expect(typeof rt.resetUsage).toBe('function');
    expect(typeof rt.setNodeStatus).toBe('function');
    expect(typeof rt.addAsset).toBe('function');
    expect(typeof rt.setEdges).toBe('function');
  });
});
