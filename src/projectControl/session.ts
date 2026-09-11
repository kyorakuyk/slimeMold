import type { MasterResponse } from './master';
import {
  addOpenQuestion,
  appendSessionMessage,
  answerOpenQuestion,
  createProjectArchitecture,
  createProjectBrief,
  transitionSession,
} from './state';
import type {
  ProjectControlSnapshot,
  ProjectSession,
  SessionMessage,
} from './types';

export interface ApplyMasterTurnInput {
  snapshot: ProjectControlSnapshot;
  sessionId: string;
  /** 初始触发主控时可以不写入用户消息；正常回合应传入用户回答。 */
  userMessage?: string;
  response: MasterResponse;
  now: string;
  createId: (prefix: string) => string;
}

function sessionOf(snapshot: ProjectControlSnapshot, sessionId: string): ProjectSession {
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`项目会话不存在：${sessionId}`);
  return session;
}

function appendAssistantMessage(
  session: ProjectSession,
  response: MasterResponse,
  now: string,
  createId: (prefix: string) => string,
): ProjectSession {
  const message: SessionMessage = {
    id: createId('message'),
    role: 'assistant',
    content: response.reply,
    createdAt: now,
  };
  return appendSessionMessage(session, message);
}

function updateSession(
  snapshot: ProjectControlSnapshot,
  session: ProjectSession,
): ProjectControlSnapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((item) => (item.id === session.id ? session : item)),
  };
}

export function applyMasterTurn(input: ApplyMasterTurnInput): ProjectControlSnapshot {
  let session = sessionOf(input.snapshot, input.sessionId);

  if (input.userMessage?.trim()) {
    const pendingQuestion = session.openQuestions.find((question) => question.status === 'open');
    if (pendingQuestion) {
      session = answerOpenQuestion(session, pendingQuestion.id, input.userMessage, input.now);
    }
    session = appendSessionMessage(session, {
      id: input.createId('message'),
      role: 'user',
      content: input.userMessage,
      createdAt: input.now,
    });
  }
  session = appendAssistantMessage(session, input.response, input.now, input.createId);

  if (input.response.kind === 'question') {
    if (session.status !== 'clarifying') {
      session = transitionSession(session, 'clarifying', input.now);
    }
    for (const question of input.response.questions) {
      if (session.openQuestions.some((item) => item.id === question.id)) continue;
      session = addOpenQuestion(session, {
        id: question.id,
        prompt: question.prompt,
        createdAt: input.now,
      });
    }
    return updateSession(input.snapshot, session);
  }

  if (input.response.kind === 'brief') {
    const existingVersions = input.snapshot.briefs
      .filter((brief) => brief.sessionId === input.sessionId)
      .map((brief) => brief.briefVersion);
    const brief = createProjectBrief({
      id: input.createId('brief'),
      sessionId: input.sessionId,
      version: Math.max(0, ...existingVersions) + 1,
      ...input.response.brief,
      now: input.now,
    });
    session = transitionSession(session, 'brief-review', input.now);
    session = { ...session, briefId: brief.id };

    return {
      ...updateSession(input.snapshot, session),
      briefs: [...input.snapshot.briefs, brief],
    };
  }

  if (!session.briefId) {
    throw new Error('架构草案必须关联一个已生成的 Brief');
  }
  const existingArchitectureVersions = input.snapshot.architectures
    .filter((architecture) => architecture.sessionId === input.sessionId)
    .map((architecture) => architecture.architectureVersion);
  const architecture = createProjectArchitecture({
    id: input.createId('architecture'),
    sessionId: input.sessionId,
    briefId: session.briefId,
    version: Math.max(0, ...existingArchitectureVersions) + 1,
    ...input.response.architecture,
    now: input.now,
  });
  session = transitionSession(session, 'architecture-review', input.now);
  session = { ...session, architectureId: architecture.id };

  return {
    ...updateSession(input.snapshot, session),
    architectures: [...input.snapshot.architectures, architecture],
  };
}
