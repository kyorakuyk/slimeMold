/**
 * H1g：nodeResultHandler 结果副作用测试。
 *
 * 覆盖：handleNodeSuccess（写缓存/登记分支/状态/事件/快照/stopAfter 剪裁）、
 * handleNodeFailure（skipFailed 分支语义/状态/事件/快照/日志）。
 */
import { describe, it, expect, vi } from 'vitest';
import { handleNodeSuccess, handleNodeFailure, type NodeSuccessInput, type NodeFailureInput } from './nodeResultHandler';

const def = { outputs: [{ id: 'out' }, { id: 'alt' }] };

function mkSuccessInput(overrides: Partial<NodeSuccessInput> = {}): NodeSuccessInput {
  return {
    id: 'a',
    node: { data: { typeId: 'x', label: 'A', params: {} } },
    def,
    outputs: { out: 'V' },
    inputs: {},
    upstreamOutputs: {},
    cacheScope: 'wfA:a',
    startedAt: 't',
    durationMs: 5,
    stopAfter: new Set(),
    cache: { key: () => 'k', set: vi.fn() },
    outputMap: { set: vi.fn() },
    branchState: { set: vi.fn() },
    h: { setStatus: vi.fn(), emit: vi.fn(), onSnapshot: vi.fn(), onCut: vi.fn(), onErrorLog: vi.fn() },
    ...overrides,
  };
}

function mkFailureInput(overrides: Partial<NodeFailureInput> = {}): NodeFailureInput {
  return {
    id: 'a',
    node: { data: { label: 'A', typeId: 'x' } },
    def,
    message: 'boom',
    startedAt: 't',
    durationMs: 5,
    skipFailed: false,
    branchState: { set: vi.fn() },
    h: { setStatus: vi.fn(), emit: vi.fn(), onSnapshot: vi.fn(), onCut: vi.fn(), onErrorLog: vi.fn() },
    ...overrides,
  };
}

describe('handleNodeSuccess', () => {
  it('写缓存 + 登记分支（普通节点全部激活）+ success 状态 + completed 事件 + 快照', () => {
    const input = mkSuccessInput();
    handleNodeSuccess(input);
    expect(input.cache.set).toHaveBeenCalledWith('k', { out: 'V' });
    expect(input.outputMap.set).toHaveBeenCalledWith('a', { out: 'V' });
    expect(input.branchState.set).toHaveBeenCalledWith('a', new Set(['out', 'alt']));
    expect(input.h.setStatus).toHaveBeenCalledWith('success', { outputs: { out: 'V' }, startedAt: 't', durationMs: 5 });
    expect(input.h.emit).toHaveBeenCalledWith('node.completed', expect.objectContaining({ status: 'success', outputs: { out: 'V' } }));
    expect(input.h.onSnapshot).toHaveBeenCalledTimes(1);
    expect(input.h.onCut).not.toHaveBeenCalled();
  });

  it('branchesTaken 存在时登记为分支声明的 handle', () => {
    const input = mkSuccessInput({ branchesTaken: ['out'] });
    handleNodeSuccess(input);
    expect(input.branchState.set).toHaveBeenCalledWith('a', new Set(['out']));
  });

  it('stopAfter 含本节点时剪裁下游', () => {
    const input = mkSuccessInput({ stopAfter: new Set(['a']) });
    handleNodeSuccess(input);
    expect(input.h.onCut).toHaveBeenCalledTimes(1);
  });
});

describe('handleNodeFailure', () => {
  it('默认：失败屏蔽下游 + error 状态 + failed 事件 + 快照 + 日志', () => {
    const input = mkFailureInput();
    handleNodeFailure(input);
    expect(input.branchState.set).toHaveBeenCalledWith('a', new Set());
    expect(input.h.setStatus).toHaveBeenCalledWith('error', { error: 'boom', startedAt: 't', durationMs: 5 });
    expect(input.h.emit).toHaveBeenCalledWith('node.failed', expect.objectContaining({ error: 'boom' }));
    expect(input.h.onSnapshot).toHaveBeenCalledTimes(1);
    expect(input.h.onErrorLog).toHaveBeenCalledWith('「A」这一步出错了：boom');
  });

  it('skipFailed：失败不屏蔽下游（全部输出 handle 激活）', () => {
    const input = mkFailureInput({ skipFailed: true });
    handleNodeFailure(input);
    expect(input.branchState.set).toHaveBeenCalledWith('a', new Set(['out', 'alt']));
  });
});
