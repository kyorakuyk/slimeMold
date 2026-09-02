import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import { createSyntheticBaselineEvents } from '../domain/migration';
import { createEmptyProjectControlSnapshot } from './persistence';
import { startProjectSessionCommand } from './commands';
import { auditProjectControlConsistency } from './projectControlConsistency';

function started() {
  return startProjectSessionCommand({
    projectId: 'project-1',
    sessionId: 'session-1',
    issueId: 'issue-1',
    projectName: '记账应用',
    goal: '做一个个人记账应用',
    now: '2026-09-01T00:00:00.000Z',
  });
}

describe('project control consistency audit', () => {
  it('accepts normal project/session/issue facts matching the ProjectFile projection', () => {
    const result = started();
    expect(auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: result.snapshot,
      events: result.events,
    })).toMatchObject({ ok: true, issues: [] });
  });

  it('reports session status drift instead of silently trusting the ProjectFile', () => {
    const result = started();
    const drifted = {
      ...result.snapshot,
      sessions: result.snapshot.sessions.map((session) => ({ ...session, status: 'paused' as const })),
    };
    const audit = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: drifted,
      events: result.events,
    });

    expect(audit.ok).toBe(false);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'session-status-drift', aggregateId: 'session-1' }),
    ]));
  });

  it('reports a ProjectFile issue whose durable fact is missing', () => {
    const result = started();
    const events = result.events.filter((event) => event.eventType !== 'IssueCreated');
    const audit = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: result.snapshot,
      events,
    });

    expect(audit.ok).toBe(false);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-issue-event', aggregateId: 'issue-1' }),
    ]));
  });

  it('accepts a synthetic legacy baseline and fails closed on an invalid stream', () => {
    const snapshot = createEmptyProjectControlSnapshot();
    const events = createSyntheticBaselineEvents({
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:00:00.000Z',
    });
    expect(auditProjectControlConsistency({ projectId: 'project-1', snapshot, events })).toMatchObject({
      ok: true,
      issues: [],
    });

    const invalid = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot,
      events: [{ ...events[0], sequence: 2 } as DomainEvent],
    });
    expect(invalid).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid-event-stream' })],
    });
  });
});
