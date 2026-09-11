import { describe, expect, it } from 'vitest';
import type { ProjectControlSnapshot } from './types';
import { applyMasterTurn } from './session';
import type { MasterResponse } from './master';

const base: ProjectControlSnapshot = {
  version: 1,
  activeSessionId: 'session-1',
  sessions: [
    {
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
    },
  ],
  decisions: [],
  briefs: [],
  architectures: [],
  issues: [],
};

const ids = (() => {
  let n = 0;
  return (prefix: string) => `created-${prefix}-${++n}`;
})();

describe('applyMasterTurn', () => {
  it('appends a user reply, assistant reply, and new open questions', () => {
    const response: MasterResponse = {
      kind: 'question',
      reply: '我先确认同步范围。',
      questions: [{ id: 'q-sync', prompt: '第一版需要云同步吗？' }],
    };
    const next = applyMasterTurn({
      snapshot: base,
      sessionId: 'session-1',
      userMessage: '先只做本地版本',
      response,
      now: '2026-08-31T03:01:00.000Z',
      createId: ids,
    });

    const session = next.sessions[0];
    expect(session.messages).toHaveLength(3);
    expect(session.messages.at(-2)).toMatchObject({ role: 'user', content: '先只做本地版本' });
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', content: response.reply });
    expect(session.openQuestions).toEqual([
      expect.objectContaining({ id: 'q-sync', status: 'open' }),
    ]);
    expect(session.status).toBe('clarifying');
    expect(base.sessions[0].messages).toHaveLength(1);
  });

  it('does not duplicate a question id returned by a later turn', () => {
    const first = applyMasterTurn({
      snapshot: base,
      sessionId: 'session-1',
      response: { kind: 'question', reply: '先问一下。', questions: [{ id: 'q-sync', prompt: '需要同步吗？' }] },
      now: '2026-08-31T03:01:00.000Z',
      createId: ids,
    });
    const second = applyMasterTurn({
      snapshot: first,
      sessionId: 'session-1',
      response: { kind: 'question', reply: '我仍需要这个答案。', questions: [{ id: 'q-sync', prompt: '需要同步吗？' }] },
      now: '2026-08-31T03:02:00.000Z',
      createId: ids,
    });

    expect(second.sessions[0].openQuestions).toHaveLength(1);
  });

  it('marks the oldest open question answered when the user submits a reply', () => {
    const withQuestion = applyMasterTurn({
      snapshot: base,
      sessionId: 'session-1',
      response: { kind: 'question', reply: '我需要确认范围。', questions: [{ id: 'q-scope', prompt: '第一版做哪些功能？' }] },
      now: '2026-08-31T03:01:00.000Z',
      createId: ids,
    });
    const next = applyMasterTurn({
      snapshot: withQuestion,
      sessionId: 'session-1',
      userMessage: '只做收入和支出记录',
      response: { kind: 'question', reply: '收到。', questions: [{ id: 'q-auth', prompt: '需要登录吗？' }] },
      now: '2026-08-31T03:02:00.000Z',
      createId: ids,
    });

    expect(next.sessions[0].openQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'q-scope', status: 'answered', answer: '只做收入和支出记录' }),
      expect.objectContaining({ id: 'q-auth', status: 'open' }),
    ]));
  });

  it('stores a draft brief and moves the session to brief review', () => {
    const response: MasterResponse = {
      kind: 'brief',
      reply: '我整理好了第一版 Brief，请确认。',
      brief: {
        goal: '做一个个人记账应用',
        users: ['个人用户'],
        scope: ['记录收入和支出'],
        nonGoals: ['暂不做多人协作'],
        constraints: ['优先本地运行'],
        acceptanceCriteria: ['可以新增一条收支记录'],
        assumptions: ['第一版使用本地存储'],
      },
    };
    const next = applyMasterTurn({
      snapshot: base,
      sessionId: 'session-1',
      response,
      now: '2026-08-31T03:03:00.000Z',
      createId: ids,
    });

    expect(next.briefs).toHaveLength(1);
    expect(next.briefs[0]).toMatchObject({
      id: expect.any(String),
      approval: 'draft',
      briefVersion: 1,
      goal: response.brief.goal,
    });
    expect(next.sessions[0]).toMatchObject({
      status: 'brief-review',
      briefId: next.briefs[0].id,
    });
  });

  it('stores an architecture draft and links it to the session', () => {
    const response: MasterResponse = {
      kind: 'architecture',
      reply: '架构草案已准备好，请审查。',
      architecture: {
        overview: '分层本地应用。',
        modules: [{
          id: 'ledger',
          name: '账本模块',
          responsibility: '管理收支',
          category: 'logic',
          scope: ['src/ledger/**'],
          dependsOn: [],
        }],
        interfaces: [],
        tasks: [{
          id: 'ledger-model',
          title: '实现模型',
          description: '实现收支模型',
          moduleId: 'ledger',
          scope: ['src/ledger/model.ts'],
          dependsOn: [],
          acceptanceCriteria: ['模型可用'],
          category: 'logic',
        }],
        risks: [],
      },
    };
    const architectureReady = {
      ...base,
      sessions: [{
        ...base.sessions[0],
        status: 'architecture-review' as const,
        briefId: 'brief-1',
      }],
    } as ProjectControlSnapshot;
    const next = applyMasterTurn({
      snapshot: architectureReady,
      sessionId: 'session-1',
      response,
      now: '2026-08-31T03:04:00.000Z',
      createId: ids,
    });

    expect(next.architectures).toHaveLength(1);
    expect(next.architectures[0]).toMatchObject({
      approval: 'draft',
      overview: response.architecture.overview,
    });
    expect(next.sessions[0]).toMatchObject({
      architectureId: next.architectures[0].id,
      status: 'architecture-review',
    });
  });
});
