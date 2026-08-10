/**
 * H1f：runLlmWithFallback 调用骨架测试。
 *
 * 覆盖：候选链逐级尝试、首个成功即返回、全部失败抛最后一个错误、
 * 信号中止立即抛、成本记录回调触发（成功/失败）。
 * 通过 vi.mock 替换 getChannel 的 chat 实现（不发起真实网络）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLlmWithFallback, type RunLlmCallInput } from './runLlmCall';
import type { AgentConfig, CostRecord } from '../types';

// mock llmChannel：chat 返回可配置结果（vi.hoisted 供 mock factory 引用）
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../agents/llmChannel', () => ({
  getChannel: () => ({ chat: chatMock }),
}));

function ag(id: string, model = 'm'): AgentConfig {
  return { id, name: id, protocol: 'openai', baseUrl: 'http://x', model } as unknown as AgentConfig;
}

function mkInput(overrides: Partial<RunLlmCallInput> = {}): RunLlmCallInput {
  return {
    chainIds: ['a', 'b'],
    byId: (id) => (id === 'a' ? ag('a') : id === 'b' ? ag('b') : undefined),
    messages: [{ role: 'user' as const, content: 'hi' }],
    effectiveMessages: [{ role: 'user' as const, content: 'hi' }],
    signal: new AbortController().signal,
    limiter: { acquire: async () => () => {} } as never,
    maxRetries: 1,
    retryBaseMs: 1,
    recordCost: () => {},
    node: { id: 'n1', label: 'N1', typeId: 'ai.chat' },
    sink: null,
    vars: {},
    toolStorage: undefined,
    toolSandbox: undefined,
    llmChannel: 'frontend',
    myRun: 1,
    targetRunId: 1,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

describe('runLlmWithFallback', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('候选链逐级尝试：首个成功即返回其文本', async () => {
    chatMock.mockImplementationOnce(async ({ agent }) => ({ text: `from-${agent.id}`, usage: undefined }));
    const out = await runLlmWithFallback(mkInput());
    expect(out).toBe('from-a');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('首个失败后尝试下一候选', async () => {
    chatMock
      .mockImplementationOnce(async () => {
        throw new Error('boom-a');
      })
      .mockImplementationOnce(async ({ agent }) => ({ text: `from-${agent.id}`, usage: undefined }));
    const out = await runLlmWithFallback(mkInput());
    expect(out).toBe('from-b');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('全部候选失败：抛最后一个错误', async () => {
    chatMock.mockImplementation(async () => {
      throw new Error('all-fail');
    });
    await expect(runLlmWithFallback(mkInput())).rejects.toThrow('all-fail');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('成本记录：失败候选记 fail、成功候选记 ok', async () => {
    const records: CostRecord[] = [];
    chatMock
      .mockImplementationOnce(async () => {
        throw new Error('x');
      })
      .mockImplementationOnce(async () => ({ text: 'ok', usage: { promptTokens: 10 } }));
    await runLlmWithFallback(mkInput({ recordCost: (rec) => records.push(rec) }));
    expect(records.length).toBe(2);
    expect(records[0]!.ok).toBe(false);
    expect(records[0]!.agentId).toBe('a');
    expect(records[1]!.ok).toBe(true);
    expect(records[1]!.agentId).toBe('b');
    expect(records[1]!.usage?.promptTokens).toBe(10);
  });

  it('候选缺失时跳过（byId 返回 undefined）', async () => {
    chatMock.mockImplementation(async ({ agent }) => ({ text: `from-${agent.id}`, usage: undefined }));
    // 链中有不存在的 id，应跳过
    const out = await runLlmWithFallback(mkInput({ chainIds: ['ghost', 'a'] }));
    expect(out).toBe('from-a');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('信号中止：立即抛出', async () => {
    const ac = new AbortController();
    chatMock.mockImplementation(async () => {
      throw new Error('abort-race');
    });
    // 中止后第一次调用应立即抛
    ac.abort();
    await expect(runLlmWithFallback(mkInput({ signal: ac.signal }))).rejects.toThrow('abort-race');
  });
});
