import { describe, expect, it } from 'vitest';
import type { ProjectBrief } from './types';
import {
  addOpenQuestion,
  answerOpenQuestion,
  approveBrief,
  approveDecision,
  createDecision,
  createProjectBrief,
  createProjectSession,
  transitionSession,
} from './state';

const NOW = '2026-08-31T03:00:00.000Z';

function session() {
  return createProjectSession({
    id: 'session-1',
    projectId: 'project-1',
    goal: '做一个个人记账应用',
    now: NOW,
  });
}

function brief(): ProjectBrief {
  return createProjectBrief({
    id: 'brief-1',
    sessionId: 'session-1',
    version: 1,
    goal: '做一个个人记账应用',
    users: ['个人用户'],
    scope: ['记录收入和支出'],
    nonGoals: ['暂不做多人协作'],
    constraints: ['优先本地运行'],
    acceptanceCriteria: ['可以新增一条收支记录'],
    assumptions: ['第一版使用本地存储'],
    now: NOW,
  });
}

describe('ProjectSession state machine', () => {
  it('creates a clarifying session with the initial user goal', () => {
    const created = session();

    expect(created).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      status: 'clarifying',
      openQuestions: [],
      decisionIds: [],
    });
    expect(created.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '做一个个人记账应用' }),
    ]);
  });

  it('allows only declared status transitions and does not mutate the original session', () => {
    const original = session();
    const next = transitionSession(original, 'brief-review', NOW);

    expect(next.status).toBe('brief-review');
    expect(next.updatedAt).toBe(NOW);
    expect(original.status).toBe('clarifying');
    expect(() => transitionSession(original, 'delivered', NOW)).toThrow(/不允许/);
  });

  it('answers an open question and keeps the question history', () => {
    const withQuestion = addOpenQuestion(session(), {
      id: 'question-1',
      prompt: '第一版是否需要登录？',
      createdAt: NOW,
    });
    const answered = answerOpenQuestion(withQuestion, 'question-1', '不需要', NOW);

    expect(answered.openQuestions).toEqual([
      expect.objectContaining({
        id: 'question-1',
        status: 'answered',
        answer: '不需要',
        answeredAt: NOW,
      }),
    ]);
    expect(withQuestion.openQuestions[0].status).toBe('open');
    expect(() => answerOpenQuestion(answered, 'question-1', '仍然不需要', NOW)).toThrow(/已经回答/);
  });
});

describe('Decision and ProjectBrief approvals', () => {
  it('creates a proposed decision and approves it explicitly', () => {
    const decision = createDecision({
      id: 'decision-1',
      sessionId: 'session-1',
      key: 'authentication',
      value: 'none-in-v1',
      version: 1,
      now: NOW,
    });
    const approved = approveDecision(decision, 'user-1', NOW);

    expect(decision.status).toBe('proposed');
    expect(approved).toMatchObject({
      status: 'approved',
      approvedBy: 'user-1',
      approvedAt: NOW,
    });
  });

  it('approves a draft brief without changing its content', () => {
    const draft = brief();
    const approved = approveBrief(draft, 'user-1', NOW);

    expect(draft.approval).toBe('draft');
    expect(approved).toMatchObject({
      approval: 'approved',
      approvedBy: 'user-1',
      approvedAt: NOW,
      goal: draft.goal,
      acceptanceCriteria: draft.acceptanceCriteria,
    });
  });

  it('rejects approving an already approved brief', () => {
    const approved = approveBrief(brief(), 'user-1', NOW);
    expect(() => approveBrief(approved, 'user-2', NOW)).toThrow(/已经批准/);
  });
});
