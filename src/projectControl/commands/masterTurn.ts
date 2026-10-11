import type { DomainEvent } from '../../domain/contracts';
import { applyMasterTurn, type ApplyMasterTurnInput } from '../session';
import { appendFact, type ProjectControlCommandResult } from './shared';

/** Apply a master turn and expose the same state transition as auditable facts. */
export function applyMasterTurnCommand(
  input: ApplyMasterTurnInput,
): ProjectControlCommandResult {
  const before = input.snapshot.sessions.find((session) => session.id === input.sessionId);
  if (!before) throw new Error(`项目会话不存在：${input.sessionId}`);
  const snapshot = applyMasterTurn(input);
  const after = snapshot.sessions.find((session) => session.id === input.sessionId);
  if (!after) throw new Error(`主控回合后会话丢失：${input.sessionId}`);

  const events: DomainEvent[] = [];
  const newMessages = after.messages.filter(
    (message) => !before.messages.some((existing) => existing.id === message.id),
  );
  for (const message of newMessages) {
    appendFact(events, {
      eventId: `${message.id}:recorded`,
      streamId: after.projectId,
      aggregateType: 'Session',
      aggregateId: after.id,
      eventType: 'SessionMessageRecorded',
      schemaVersion: 1,
      payload: {
        sessionId: after.id,
        messageId: message.id,
        role: message.role,
        content: message.content,
      },
      actor: message.role === 'user' ? 'user' : 'master',
      occurredAt: message.createdAt,
      correlationId: after.id,
      source: { objectId: after.id, objectVersion: 1 },
      sensitivity: 'private',
    });
  }

  const responsePayload =
    input.response.kind === 'question'
      ? {
          responseKind: input.response.kind,
          questionIds: input.response.questions.map((question) => question.id),
        }
      : input.response.kind === 'brief'
        ? { responseKind: input.response.kind, briefId: after.briefId ?? null }
        : { responseKind: input.response.kind, architectureId: after.architectureId ?? null };
  appendFact(events, {
    eventId: `${after.id}:master-turn:${after.messages.at(-1)?.id ?? input.now}`,
    streamId: after.projectId,
    aggregateType: 'Session',
    aggregateId: after.id,
    eventType: 'MasterTurnCompleted',
    schemaVersion: 1,
    payload: { sessionId: after.id, ...responsePayload },
    actor: 'master',
    occurredAt: input.now,
    correlationId: after.id,
    source: { objectId: after.id, objectVersion: 1 },
    sensitivity: 'private',
  });

  if (input.response.kind === 'brief' && after.briefId) {
    const brief = snapshot.briefs.find((item) => item.id === after.briefId);
    if (brief) {
      appendFact(events, {
        eventId: `${brief.id}:proposed`,
        streamId: after.projectId,
        aggregateType: 'Brief',
        aggregateId: brief.id,
        eventType: 'BriefProposed',
        schemaVersion: 1,
        payload: { briefId: brief.id, sessionId: after.id, briefVersion: brief.briefVersion },
        actor: 'master',
        occurredAt: brief.createdAt,
        correlationId: after.id,
        source: { objectId: brief.id, objectVersion: brief.briefVersion },
        sensitivity: 'private',
      });
    }
  }
  if (input.response.kind === 'architecture' && after.architectureId) {
    const architecture = snapshot.architectures.find((item) => item.id === after.architectureId);
    if (architecture) {
      appendFact(events, {
        eventId: `${architecture.id}:proposed`,
        streamId: after.projectId,
        aggregateType: 'Architecture',
        aggregateId: architecture.id,
        eventType: 'ArchitectureProposed',
        schemaVersion: 1,
        payload: {
          architectureId: architecture.id,
          sessionId: after.id,
          briefId: architecture.briefId,
          architectureVersion: architecture.architectureVersion,
        },
        actor: 'master',
        occurredAt: architecture.createdAt,
        correlationId: after.id,
        source: { objectId: architecture.id, objectVersion: architecture.architectureVersion },
        sensitivity: 'private',
      });
    }
  }

  return { snapshot, events };
}
