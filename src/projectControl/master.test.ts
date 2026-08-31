import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, LLMResponse } from '../types';
import type { ProjectSession } from './types';
import {
  buildMasterMessages,
  parseMasterResponse,
  resolveMasterAgent,
  runMasterTurn,
} from './master';

const agent = {
  id: 'agent-1',
  name: '本地主控',
  protocol: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen2.5:3b',
} satisfies AgentConfig;

const session: ProjectSession = {
  version: 1,
  id: 'session-1',
  projectId: 'project-1',
  status: 'clarifying',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: '做一个个人记账应用',
      createdAt: '2026-08-31T03:00:00.000Z',
    },
  ],
  openQuestions: [],
  decisionIds: [],
  createdAt: '2026-08-31T03:00:00.000Z',
  updatedAt: '2026-08-31T03:00:00.000Z',
};

describe('parseMasterResponse', () => {
  it('parses a fenced question response', () => {
    const response = parseMasterResponse(`\n\`\`\`json
{"kind":"question","reply":"我先确认一个关键取舍。","questions":[{"id":"q-storage","prompt":"第一版需要云同步吗？"}]}
\`\`\``);

    expect(response).toEqual({
      kind: 'question',
      reply: '我先确认一个关键取舍。',
      questions: [{ id: 'q-storage', prompt: '第一版需要云同步吗？' }],
    });
  });

  it('parses a brief response and normalizes missing arrays', () => {
    const response = parseMasterResponse(
      JSON.stringify({
        kind: 'brief',
        reply: '我已经整理出第一版项目 Brief，请确认。',
        brief: {
          goal: '做一个个人记账应用',
          users: ['个人用户'],
          scope: ['记录收入和支出'],
        },
      }),
    );

    expect(response.kind).toBe('brief');
    if (response.kind !== 'brief') throw new Error('expected brief response');
    expect(response.brief).toMatchObject({
      goal: '做一个个人记账应用',
      users: ['个人用户'],
      scope: ['记录收入和支出'],
      nonGoals: [],
      constraints: [],
      acceptanceCriteria: [],
      assumptions: [],
    });
  });

  it('parses an architecture response with modules, interfaces, tasks, and risks', () => {
    const response = parseMasterResponse(JSON.stringify({
      kind: 'architecture',
      reply: '我整理了第一版架构和施工任务，请审查。',
      architecture: {
        overview: '本地优先的分层记账应用。',
        modules: [{
          id: 'ledger',
          name: '账本模块',
          responsibility: '记录和查询收支',
          category: 'logic',
          scope: ['src/ledger/**'],
          dependsOn: [],
        }],
        interfaces: [{
          id: 'ledger-service',
          name: 'LedgerService',
          description: '提供收支记录接口',
        }],
        tasks: [{
          id: 'ledger-model',
          title: '实现收支数据模型',
          description: '定义收入和支出的结构',
          moduleId: 'ledger',
          scope: ['src/ledger/model.ts'],
          dependsOn: [],
          acceptanceCriteria: ['可以保存一条收支记录'],
          category: 'logic',
        }],
        risks: ['本地存储迁移需要额外设计'],
      },
    }));

    expect(response.kind).toBe('architecture');
    if (response.kind !== 'architecture') throw new Error('expected architecture response');
    expect(response.architecture.modules[0]).toMatchObject({ id: 'ledger', category: 'logic' });
    expect(response.architecture.tasks[0]).toMatchObject({ moduleId: 'ledger' });
  });

  it('rejects malformed output and more than three questions', () => {
    expect(() => parseMasterResponse('这不是结构化主控输出')).toThrow(/合法 JSON/);
    expect(() =>
      parseMasterResponse(
        JSON.stringify({
          kind: 'question',
          reply: '请回答这些问题',
          questions: [
            { id: '1', prompt: 'a' },
            { id: '2', prompt: 'b' },
            { id: '3', prompt: 'c' },
            { id: '4', prompt: 'd' },
          ],
        }),
      ),
    ).toThrow(/最多 3/);
  });
});

describe('resolveMasterAgent', () => {
  it('prefers project override, then global master, then project default, then first enabled agent', () => {
    const second = { ...agent, id: 'agent-2', name: '备用' };

    expect(resolveMasterAgent({ agents: [agent, second], defaultAgentId: 'agent-2' }).id).toBe('agent-2');
    expect(resolveMasterAgent({ agents: [agent, second], defaultAgentId: 'agent-2', requestedAgentId: 'agent-1' }).id).toBe('agent-1');
    expect(resolveMasterAgent({ agents: [agent, second], globalMasterAgentId: 'agent-2', defaultAgentId: 'agent-1' }).id).toBe('agent-2');
    expect(resolveMasterAgent({ agents: [agent, second], globalMasterAgentId: 'missing', defaultAgentId: 'agent-2' }).id).toBe('agent-2');
    expect(resolveMasterAgent({ agents: [{ ...agent, enabled: false }, second] }).id).toBe('agent-2');
    expect(() => resolveMasterAgent({ agents: [] })).toThrow(/没有可用/);
  });
});

describe('buildMasterMessages / runMasterTurn', () => {
  it('keeps the project context in a bounded, explicit system message', () => {
    const messages = buildMasterMessages({
      session,
      userMessage: '不需要云同步',
      currentBrief: null,
      decisions: [],
    });

    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(String(messages[0].content)).toContain('只能提出问题或 Brief 草案');
    expect(messages.at(-1)).toEqual({ role: 'user', content: '不需要云同步' });
  });

  it('uses the injected chat function and returns a parsed response', async () => {
    const chat = vi.fn(async (): Promise<LLMResponse> => ({
      text: JSON.stringify({
        kind: 'question',
        reply: '收到。',
        questions: [{ id: 'q-1', prompt: '目标用户是谁？' }],
      }),
    }));

    const result = await runMasterTurn(
      {
        agent,
        session,
        userMessage: '继续',
        currentBrief: null,
        decisions: [],
      },
      { chat },
    );

    expect(result.response.kind).toBe('question');
    expect(chat).toHaveBeenCalledTimes(1);
    const calls = chat.mock.calls as unknown as Array<[AgentConfig, unknown]>;
    expect(calls[0][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '继续' }),
    ]));
  });
});
