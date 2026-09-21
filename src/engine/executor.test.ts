import { ExecContext } from '../types/node';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  collectInputs, resolveCapability, applyCapability, getActiveRunId, workflowRequiresDevSession, } from './executor';
import type { NodeDefinition } from '../types/node';
import { useWorkflowStore } from '../store/workflowStore';

function def(typeId: string, minCapability?: 'compute' | 'io' | 'sandbox_write' | 'coordinator' | 'system'): NodeDefinition {
  return {
    typeId,
    name: typeId,
    category: '测试',
    description: '',
    inputs: [],
    outputs: [],
    execute: async () => ({}),
    params: [],
    ...(minCapability ? { minCapability } : {}),
  } as unknown as NodeDefinition;
}

describe('collectInputs', () => {
  it('汇集单个上游节点的输出到对应 targetHandle', () => {
    const edges = [{ id: 'e1', source: 'a', sourceHandle: 'out1', target: 'b', targetHandle: 'in1' }];
    const outputs = new Map([['a', { out1: 'hello' }]]);
    const r = collectInputs('b', edges as never, outputs);
    expect(r).toEqual({ in1: 'hello' });
  });

  it('多上游按 targetHandle 分别映射', () => {
    const edges = [
      { id: 'e1', source: 'a', sourceHandle: 'o1', target: 'c', targetHandle: 'i1' },
      { id: 'e2', source: 'b', sourceHandle: 'o2', target: 'c', targetHandle: 'i2' },
    ];
    const outputs = new Map<string, Record<string, unknown>>([
      ['a', { o1: 1 }],
      ['b', { o2: 2 }],
    ]);
    const r = collectInputs('c', edges as never, outputs);
    expect(r).toEqual({ i1: 1, i2: 2 });
  });

  it('缺失的上游输出被跳过（不写入该 handle）', () => {
    const edges = [
      { id: 'e1', source: 'a', sourceHandle: 'o1', target: 'c', targetHandle: 'i1' },
      { id: 'e2', source: 'missing', sourceHandle: 'o2', target: 'c', targetHandle: 'i2' },
    ];
    const outputs = new Map([['a', { o1: 1 }]]);
    const r = collectInputs('c', edges as never, outputs);
    expect(r).toEqual({ i1: 1 });
    expect('i2' in r).toBe(false);
  });

  it('sourceHandle 缺省时取空字符串 key', () => {
    const edges = [{ id: 'e1', source: 'a', target: 'b', targetHandle: 'in1' }];
    const outputs = new Map([['a', { '': 'default' }]]);
    const r = collectInputs('b', edges as never, outputs);
    expect(r).toEqual({ in1: 'default' });
  });
});

describe('workflowRequiresDevSession', () => {
  it('含 dev.* 节点时要求先准备宿主开发会话', () => {
    expect(workflowRequiresDevSession([
      { data: { typeId: 'dev.worktree.create' } },
    ] as never)).toBe(true);
  });

  it('纯 builtin 图不触发宿主开发会话', () => {
    expect(workflowRequiresDevSession([
      { data: { typeId: 'input.text' } },
    ] as never)).toBe(false);
  });
});

describe('resolveCapability', () => {
  it('minCapability 显式声明优先', () => {
    expect(resolveCapability(def('compute.thing', 'coordinator'))).toBe('coordinator');
  });

  it('coord. 前缀 -> coordinator', () => {
    expect(resolveCapability(def('coord.resolver'))).toBe('coordinator');
    expect(resolveCapability(def('flow.council'))).toBe('coordinator');
  });

  it('写文件类 -> sandbox_write', () => {
    expect(resolveCapability(def('tool.writeFile'))).toBe('sandbox_write');
    expect(resolveCapability(def('fs.write'))).toBe('sandbox_write');
  });

  it('普通 IO/工具/worker/agent 类 -> io', () => {
    expect(resolveCapability(def('agent.gpt'))).toBe('io');
    expect(resolveCapability(def('worker.scaffolder'))).toBe('io');
    expect(resolveCapability(def('dispatch.plan'))).toBe('io');
    expect(resolveCapability(def('image.gen'))).toBe('io');
  });

  it('未知类型 -> compute', () => {
    expect(resolveCapability(def('my.custom'))).toBe('compute');
  });
});

describe('applyCapability', () => {
  function makeCtx(): ExecContext {
    return {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      llm: vi.fn().mockResolvedValue('ok'),
      storage: { get: vi.fn(), set: vi.fn() } as never,
      addAsset: vi.fn(),
      sandbox: undefined,
      sandboxLanes: undefined,
    } as unknown as ExecContext;
  }

  it('compute 级禁用 llm/storage/sandbox', async () => {
    const ctx = makeCtx();
    applyCapability(ctx, def('my.custom'), {});
    await expect(ctx.llm('x' as never, [] as never)).rejects.toThrow(/权限不足/);
    expect(ctx.storage.get).toBeDefined(); // storage 被替换为 no-op
    expect(ctx.sandbox).toBeUndefined();
  });

  it('io 级禁用 sandbox 句柄', () => {
    const ctx = makeCtx();
    ctx.sandbox = { writeFile: vi.fn() } as never;
    applyCapability(ctx, def('agent.gpt'), {});
    expect(ctx.sandbox).toBeUndefined();
  });

  it('sandbox_write 级剥离 commit 汇总权', async () => {
    const ctx = makeCtx();
    const realCommit = vi.fn().mockResolvedValue(undefined);
    ctx.sandbox = { commitAll: realCommit, commitLanes: realCommit } as never;
    applyCapability(ctx, def('tool.writeFile'), { sandbox: true });
    // commitAll 被替换为拒绝型实现
    await expect((ctx.sandbox as unknown as { commitAll(): Promise<void> }).commitAll()).rejects.toThrow(/仅协调者/);
  });

  it('coordinator 级保留全权限（不剥离 commit）', async () => {
    const ctx = makeCtx();
    const realCommit = vi.fn().mockResolvedValue('committed');
    ctx.sandbox = { commitAll: realCommit } as never;
    applyCapability(ctx, def('coord.resolver'), { sandbox: true });
    // coordinator 的 commitAll 仍可用（未被替换）
    const r = await (ctx.sandbox as unknown as { commitAll(): Promise<string> }).commitAll();
    expect(r).toBe('committed');
  });
});

describe('getActiveRunId', () => {
  beforeEach(() => {
    useWorkflowStore.getState().setPipelines([]);
    useWorkflowStore.setState({ activeWfId: 'wf-test' });
  });

  it('返回当前激活工作流的代次号', () => {
    const id = getActiveRunId('wf-test');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThanOrEqual(0);
  });

  it('未指定 wfId 时回退到 store.activeWfId', () => {
    const id = getActiveRunId();
    expect(typeof id).toBe('number');
  });
});
