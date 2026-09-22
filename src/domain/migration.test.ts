import { describe, expect, it } from 'vitest';
import type { ProjectControlSnapshot } from '../projectControl/types';
import { EventStreamRepository, InMemoryEventStoreAdapter } from './eventStore';
import { createSyntheticBaselineEvents, migrateLegacyProjectControl } from './migration';
import type { WorkerRunQueueState } from './workerQueue';

const snapshot: ProjectControlSnapshot = {
  version: 1,
  activeSessionId: 'session-1',
  masterAgentId: 'agent-master',
  sessions: [{
    version: 1,
    id: 'session-1',
    projectId: 'project-1',
    status: 'plan-review',
    messages: [{ id: 'message-1', role: 'user', content: '做一个项目', createdAt: '2026-09-01T00:00:00.000Z' }],
    openQuestions: [],
    decisionIds: ['decision-1'],
    briefId: 'brief-1',
    architectureId: 'architecture-1',
    taskGraphId: 'graph-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  }],
  decisions: [{
    version: 1,
    id: 'decision-1',
    sessionId: 'session-1',
    key: 'scope',
    value: { secret: 'must-not-be-copied' },
    status: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:01:00.000Z',
  }],
  briefs: [{
    version: 1,
    id: 'brief-1',
    sessionId: 'session-1',
    briefVersion: 2,
    goal: '做一个项目',
    users: ['开发者'],
    scope: ['控制面'],
    nonGoals: [],
    constraints: ['本地优先'],
    acceptanceCriteria: ['测试通过'],
    assumptions: [],
    approval: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:01:00.000Z',
  }],
  architectures: [{
    version: 1,
    id: 'architecture-1',
    sessionId: 'session-1',
    briefId: 'brief-1',
    architectureVersion: 1,
    overview: '分层架构',
    modules: [],
    interfaces: [],
    tasks: [],
    risks: ['迁移风险'],
    approval: 'draft',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  }],
  issues: [{
    version: 1,
    id: 'issue-1',
    projectId: 'project-1',
    type: 'idea',
    status: 'inbox',
    priority: 'normal',
    title: '保留想法',
    description: '迁移后仍可追踪',
    tags: ['migration'],
    relatedArtifactIds: [],
    relatedTaskIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  }],
  taskGraphs: [{
    version: 1,
    id: 'graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 1,
    tasks: [],
    approval: 'draft',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  }],
};

describe('synthetic v1 project-control baseline migration', () => {
  it('emits deterministic, source-labelled baseline events without pretending to replay approval history', () => {
    const events = createSyntheticBaselineEvents({
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:02:00.000Z',
      migrationId: 'migration-1',
    });

    expect(events.map((item) => item.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events).toEqual(createSyntheticBaselineEvents({
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:02:00.000Z',
      migrationId: 'migration-1',
    }));
    expect(events[0]).toMatchObject({
      eventType: 'ProjectControlBaselineImported',
      actor: 'system',
      synthetic: true,
      source: { objectId: 'project-1:projectControl', objectVersion: 1 },
    });
    expect(events.some((item) => item.eventType === 'ProjectMasterOverrideSet')).toBe(true);
    expect(events.some((item) => item.eventType === 'LegacyDecisionImported')).toBe(true);
    expect(events.some((item) => item.eventType === 'DecisionApproved')).toBe(false);

    const decision = events.find((item) => item.eventType === 'LegacyDecisionImported');
    expect(decision?.payload).toMatchObject({ id: 'decision-1', status: 'approved' });
    expect(decision?.payload).not.toHaveProperty('value');
    expect(decision?.payload).toHaveProperty('valueHash');
    expect(events.every((item) => item.actor === 'system' && item.synthetic === true && item.source)).toBe(true);
  });

  it('keeps an empty legacy control plane representable as one synthetic baseline event', () => {
    const events = createSyntheticBaselineEvents({
      projectId: 'project-empty',
      snapshot: {
        version: 1,
        activeSessionId: null,
        masterAgentId: null,
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
      },
      now: '2026-09-01T00:02:00.000Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'ProjectControlBaselineImported',
      aggregateId: 'project-empty',
      payload: { counts: { sessions: 0, decisions: 0, briefs: 0, architectures: 0, issues: 0, taskGraphs: 0 } },
    });
  });

  it('rejects migrating a succeeded Worker snapshot without Acceptance provenance', () => {
    const invalidRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-invalid-success',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'succeeded',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'succeeded',
          attempt: 1,
          evidenceIds: ['evidence-1'],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    };

    expect(() => createSyntheticBaselineEvents({
      projectId: 'project-1',
      snapshot,
      workerRuns: [invalidRun],
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/provenance|Acceptance|acceptance/);
  });

  it('writes a baseline batch once and refuses to overwrite a non-migration event stream', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new EventStreamRepository(adapter, 'project-root');
    const input = {
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:02:00.000Z',
      migrationId: 'migration-1',
    };

    const created = await migrateLegacyProjectControl(repository, input);
    expect(created.status).toBe('created');
    const repeated = await migrateLegacyProjectControl(repository, input);
    expect(repeated.status).toBe('already-present');
    expect((await repository.readStream()).events).toEqual(created.events);

    const otherAdapter = new InMemoryEventStoreAdapter();
    const otherRepository = new EventStreamRepository(otherAdapter, 'project-root');
    await otherRepository.append({
      eventId: 'runtime-event',
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Run',
      aggregateId: 'run-1',
      aggregateVersion: 1,
      eventType: 'RunCreated',
      schemaVersion: 1,
      payload: {},
      actor: 'runtime',
      occurredAt: input.now,
    }, 0);
    await expect(migrateLegacyProjectControl(otherRepository, input)).rejects.toThrow(/非空事件流/);
  });

  it('rejects worker snapshot facts belonging to another project', () => {
    const foreignRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-foreign',
      runId: 'run-foreign',
      taskGraphId: 'graph-foreign',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      tasks: {},
    };

    expect(() => createSyntheticBaselineEvents({
      projectId: 'project-1',
      snapshot,
      workerRuns: [foreignRun],
      now: '2026-09-01T00:02:00.000Z',
    })).toThrow(/project|项目/);
  });
});
