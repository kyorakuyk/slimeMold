import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import type { ProjectBrief, ProjectPlan } from './types';
import { createSyntheticBaselineEvents } from '../domain/migration';
import { createEmptyProjectControlSnapshot } from './persistence';
import { proposeProjectPlanCommand, startProjectSessionCommand, transitionIssueCommand } from './commands';
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

  it('reports an approved versioned aggregate whose approval fact is missing', () => {
    const result = started();
    const brief: ProjectBrief = {
      version: 1,
      id: 'brief-1',
      sessionId: 'session-1',
      briefVersion: 1,
      goal: '做一个项目',
      users: [],
      scope: ['最小版本'],
      nonGoals: [],
      constraints: [],
      acceptanceCriteria: ['测试通过'],
      assumptions: [],
      approval: 'approved',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      approvedBy: 'user',
      approvedAt: '2026-09-01T00:01:00.000Z',
    };
    const proposed: DomainEvent = {
      eventId: 'brief-1:proposed',
      streamId: 'project-1',
      sequence: 4,
      aggregateType: 'Brief',
      aggregateId: 'brief-1',
      aggregateVersion: 1,
      eventType: 'BriefProposed',
      schemaVersion: 1,
      payload: { briefId: 'brief-1', sessionId: 'session-1', briefVersion: 1 },
      actor: 'master',
      occurredAt: '2026-09-01T00:00:30.000Z',
      correlationId: 'session-1',
      source: { objectId: 'brief-1', objectVersion: 1 },
      sensitivity: 'private',
    };
    const audit = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: {
        ...result.snapshot,
        briefs: [brief],
      },
      events: [...result.events, proposed],
    });

    expect(audit.ok).toBe(false);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'brief-approval-drift', aggregateId: 'brief-1' }),
    ]));
  });

  it('reports Issue status drift from a durable IssueStatusChanged fact', () => {
    const result = started();
    const transitioned = transitionIssueCommand({
      snapshot: result.snapshot,
      issueId: 'issue-1',
      status: 'triaging',
      now: '2026-09-01T00:01:00.000Z',
    });
    const events = [
      ...result.events,
      { ...transitioned.events[0], sequence: 4, aggregateVersion: 2 },
    ];
    const audit = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: {
        ...transitioned.snapshot,
        issues: transitioned.snapshot.issues.map((issue) => ({ ...issue, status: 'approved' as const })),
      },
      events,
    });

    expect(audit.ok).toBe(false);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'issue-status-drift', aggregateId: 'issue-1' }),
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

  it('recognizes ProjectPlan facts and reports plan version drift', () => {
    const result = started();
    const plan: ProjectPlan = {
      version: 1,
      id: 'project-plan-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      planVersion: 1,
      requirementsRef: { id: 'requirements-1', version: 1 },
      solutionRef: { id: 'solution-1', version: 1 },
      feasibilityRef: { id: 'feasibility-1', version: 1 },
      milestonePlanRef: { id: 'milestones-1', version: 1 },
      departmentCharterRefs: [{ id: 'charter-1', version: 1 }],
      feasibilityStatus: 'feasible',
      blockingQuestionCount: 0,
      approval: 'draft',
      createdAt: '2026-09-12T09:05:00.000Z',
      updatedAt: '2026-09-12T09:05:00.000Z',
    };
    const proposed = proposeProjectPlanCommand({
      snapshot: result.snapshot,
      plan,
      now: '2026-09-12T09:06:00.000Z',
    });
    const events = [
      ...result.events,
      { ...proposed.events[0], sequence: 4 },
    ];
    const consistent = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: proposed.snapshot,
      events,
    });
    expect(consistent.ok).toBe(true);
    expect(consistent.recognizedEventCount).toBe(4);

    const drifted = auditProjectControlConsistency({
      projectId: 'project-1',
      snapshot: {
        ...proposed.snapshot,
        projectPlans: [{ ...plan, planVersion: 2 }],
      },
      events,
    });
    expect(drifted.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'project-plan-version-drift', aggregateId: 'project-plan-1' }),
    ]));
  });
});
