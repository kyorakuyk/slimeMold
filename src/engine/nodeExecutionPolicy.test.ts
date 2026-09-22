/**
 * H1e：nodeExecutionPolicy 前置决策测试。
 *
 * 覆盖：upstream-failed / missing-def / bypass / mute / incremental-skip /
 * pruned（分支剪枝）/ cut（stopAfter 裁剪）/ cached（缓存命中）/ execute 全部分支。
 */
import { describe, it, expect } from 'vitest';
import { decideNodeExecution, isBranchPruned, type NodeExecutionDecisionInput } from './nodeExecutionPolicy';
import type { FlowNode, FlowEdge } from '../types';
import type { NodeExecutionMode } from './graphAlgo';

function mkNode(id: string, patch: Partial<FlowNode['data']> = {}): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId: 'x', label: id, params: {}, status: 'idle', dirty: true, bypass: false, mute: false, ...patch },
  } as unknown as FlowNode;
}

function mkEdge(id: string, source: string, target: string, sourceHandle = 'out'): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle: 'in', data: { kind: 'data' } } as unknown as FlowEdge;
}

// bypass 透传要求输入端口与输出端口同名（原 executor 语义）
const def = { typeId: 'x', inputs: [{ id: 'out' }], outputs: [{ id: 'out' }] };

const cacheHooks = {
  collectInputs: () => ({}),
  cacheKey: (_t: string, _p: Record<string, unknown>, _u: Record<string, unknown>, s: string) => `k-${s}`,
  getCached: () => null,
};

function base(id = 'a', overrides: Partial<NodeExecutionDecisionInput> = {}): NodeExecutionDecisionInput {
  return {
    id,
    node: mkNode(id),
    def,
    incoming: [],
    edges: [],
    outputsMap: new Map(),
    branchState: new Map(),
    cutSet: new Set(),
    skipFailed: false,
    mode: { kind: 'execute' } as NodeExecutionMode,
    forced: false,
    isolated: false,
    cacheScope: 'wfA:a',
    cacheHooks,
    ...overrides,
  };
}

describe('decideNodeExecution 前置决策', () => {
  it('execute：无任何跳过条件', () => {
    expect(decideNodeExecution(base()).kind).toBe('execute');
  });

  it('upstream-failed：上游失败传染', () => {
    const d = decideNodeExecution(base('a', { mode: { kind: 'upstream-failed' } as NodeExecutionMode }));
    expect(d.kind).toBe('upstream-failed');
  });

  it('missing-def：节点类型缺失', () => {
    const d = decideNodeExecution(base('a', { mode: { kind: 'missing-def' } as NodeExecutionMode }));
    expect(d).toEqual({ kind: 'missing-def', typeId: 'x' });
  });

  it('bypass：同名端口透传上游输出', () => {
    const outputsMap = new Map([['src', { out: 'V' }]]);
    const d = decideNodeExecution(base('a', {
      node: mkNode('a', { bypass: true }),
      mode: { kind: 'bypass' } as NodeExecutionMode,
      incoming: [{ id: 'e', source: 'src', target: 'a', sourceHandle: 'out', targetHandle: 'out', data: { kind: 'data' } } as unknown as FlowEdge],
      outputsMap,
    }));
    expect(d.kind).toBe('bypass');
    if (d.kind === 'bypass') expect(d.outputs).toEqual({ out: 'V' });
  });

  it('mute：不执行', () => {
    const d = decideNodeExecution(base('a', { node: mkNode('a', { mute: true }), mode: { kind: 'mute' } as NodeExecutionMode }));
    expect(d.kind).toBe('mute');
  });

  it('incremental-skip：增量且不应执行', () => {
    const d = decideNodeExecution(base('a', { mode: { kind: 'incremental-skip', prevStatus: 'success' } as NodeExecutionMode }));
    expect(d).toEqual({ kind: 'incremental-skip', prevStatus: 'success' });
  });

  it('incremental-skip：恢复缓存中的分支 handles', () => {
    const d = decideNodeExecution(base('gate', {
      mode: { kind: 'incremental-skip', prevStatus: 'success' } as NodeExecutionMode,
      cacheHooks: {
        ...cacheHooks,
        getCachedBranches: (key: string) => {
          expect(key).toBe('k-wfA:gate');
          return ['pass'];
        },
      },
      cacheScope: 'wfA:gate',
    }));
    expect(d).toEqual({ kind: 'incremental-skip', prevStatus: 'success', branches: ['pass'] });
  });

  it('pruned：所有入边来自未激活分支', () => {
    const branchState = new Map<string, Set<string | undefined>>();
    branchState.set('src', new Set()); // 空集合 = 全屏蔽
    const d = decideNodeExecution(base('a', {
      incoming: [mkEdge('e', 'src', 'a', 'out')],
      branchState,
    }));
    expect(d.kind).toBe('pruned');
  });

  it('pruned 被 skipFailed 跳过（跳过失败继续时下游不剪枝）', () => {
    const branchState = new Map<string, Set<string | undefined>>();
    branchState.set('src', new Set());
    const d = decideNodeExecution(base('a', {
      incoming: [mkEdge('e', 'src', 'a', 'out')],
      branchState,
      skipFailed: true,
    }));
    expect(d.kind).toBe('execute');
  });

  it('cut：stopAfter 下游被裁剪', () => {
    const d = decideNodeExecution(base('a', { cutSet: new Set(['a']) }));
    expect(d.kind).toBe('cut');
  });

  it('cached：命中缓存返回 outputs', () => {
    const cached = { out: 'cached-val' };
    const d = decideNodeExecution(base('a', { cacheHooks: { ...cacheHooks, getCached: () => cached } }));
    expect(d).toEqual({ kind: 'cached', outputs: cached });
  });

  it('forced 时跳过缓存判定（强制重算）', () => {
    const d = decideNodeExecution(base('a', {
      forced: true,
      cacheHooks: { ...cacheHooks, getCached: () => ({ out: 'x' }) },
    }));
    expect(d.kind).toBe('execute');
  });
});

describe('isBranchPruned 分支剪枝', () => {
  it('未登记源 = 全部激活，不剪', () => {
    const branchState = new Map<string, Set<string | undefined>>();
    expect(isBranchPruned([mkEdge('e', 'src', 'a')], branchState, false)).toBe(false);
  });

  it('空集合 = 全屏蔽，剪', () => {
    const branchState = new Map<string, Set<string | undefined>>();
    branchState.set('src', new Set());
    expect(isBranchPruned([mkEdge('e', 'src', 'a', 'out')], branchState, false)).toBe(true);
  });

  it('具体 handle：未激活则剪', () => {
    const branchState = new Map<string, Set<string | undefined>>();
    branchState.set('src', new Set(['pass']));
    expect(isBranchPruned([mkEdge('e', 'src', 'a', 'fail')], branchState, false)).toBe(true);
    expect(isBranchPruned([mkEdge('e', 'src', 'a', 'pass')], branchState, false)).toBe(false);
  });
});
