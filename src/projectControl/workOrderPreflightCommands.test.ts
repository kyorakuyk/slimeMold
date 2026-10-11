import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import { startProjectSessionCommand } from './commands';
import { auditProjectControlConsistency } from './projectControlConsistency';
import {
  workOrderDigest,
  type WorkOrderPreflightGuessPoint,
  type WorkOrderPreflightWaivedPayload,
} from './workOrderPreflight';
import { recordWorkOrderPreflightCommand } from './workOrderPreflightCommands';
import type { ProjectControlSnapshot, ProjectTaskGraph } from './types';

const now = '2026-10-11T16:00:00.000Z';
const workOrderText = '任务：调整路由\n验收：覆盖空输入';
const guessPoint: WorkOrderPreflightGuessPoint = {
  quote: '验收：覆盖空输入',
  question: '空输入具体指空字符串还是缺失字段？',
  consequence: '会影响验收范围',
  severity: 'blocking',
};

function snapshotFixture(): ProjectControlSnapshot {
  const graph: ProjectTaskGraph = {
    version: 1,
    id: 'graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 3,
    tasks: [{
      version: 1,
      id: 'task-1',
      architectureId: 'architecture-1',
      title: '调整路由',
      description: '调整路由并补测试',
      moduleId: 'routing',
      scope: ['src/routing.ts', 'src/router.ts', 'src/routes.ts'],
      dependsOn: [],
      acceptanceCriteria: ['覆盖空输入'],
      category: 'logic',
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    }],
    approval: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: 1,
    activeSessionId: 'session-1',
    sessions: [{
      version: 1,
      id: 'session-1',
      projectId: 'project-1',
      status: 'plan-review',
      messages: [],
      openQuestions: [],
      decisionIds: [],
      taskGraphId: graph.id,
      createdAt: now,
      updatedAt: now,
    }],
    decisions: [],
    briefs: [],
    architectures: [],
    issues: [],
    taskGraphs: [graph],
  };
}

function commandInput(snapshot: ProjectControlSnapshot) {
  return {
    snapshot,
    preflightId: 'preflight-1',
    taskGraphId: 'graph-1',
    taskId: 'task-1',
    graphVersion: 3,
    workOrderText,
    rawResponse: JSON.stringify([guessPoint]),
    model: 'fixture-model',
    cost: { status: 'not-metered' as const },
    now,
  };
}

describe('recordWorkOrderPreflightCommand', () => {
  it('records a shadow event without changing the task graph or approval', () => {
    const snapshot = snapshotFixture();
    const result = recordWorkOrderPreflightCommand(commandInput(snapshot));

    expect(result.snapshot).toBe(snapshot);
    expect(result.snapshot.taskGraphs?.[0].approval).toBe('draft');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: 'WorkOrderPreflightCompleted',
      streamId: 'project-1',
      aggregateType: 'TaskGraph',
      aggregateId: 'graph-1',
      payload: {
        preflightId: 'preflight-1',
        taskGraphId: 'graph-1',
        taskId: 'task-1',
        graphVersion: 3,
        workOrderDigest: workOrderDigest(workOrderText),
        model: 'fixture-model',
        verdict: 'ambiguous',
        guessPoints: [guessPoint],
        droppedCount: 0,
        cost: { status: 'not-metered' },
        mode: 'shadow',
        createdAt: now,
      },
    });
  });

  it('records an unusable response as unknown rather than clear or a command failure', () => {
    const result = recordWorkOrderPreflightCommand({
      ...commandInput(snapshotFixture()),
      rawResponse: '{invalid JSON',
    });
    expect(result.events[0].payload).toMatchObject({ verdict: 'unknown', guessPoints: [] });
  });

  it('persists the number of rejected guess points in the event payload', () => {
    const result = recordWorkOrderPreflightCommand({
      ...commandInput(snapshotFixture()),
      rawResponse: JSON.stringify([
        guessPoint,
        { ...guessPoint, quote: '不是施工单原文' },
      ]),
    });

    expect(result.events[0].payload).toMatchObject({
      verdict: 'ambiguous',
      guessPoints: [guessPoint],
      droppedCount: 1,
    });
  });

  it('rejects a stale graph version or a task outside the selected graph', () => {
    const snapshot = snapshotFixture();
    expect(() => recordWorkOrderPreflightCommand({ ...commandInput(snapshot), graphVersion: 2 }))
      .toThrow(/版本已过期/);
    expect(() => recordWorkOrderPreflightCommand({ ...commandInput(snapshot), taskId: 'other-task' }))
      .toThrow(/task/);
  });

  it('skips L0 straight-through graphs instead of recording a preflight', () => {
    const snapshot = snapshotFixture();
    const graph = snapshot.taskGraphs![0];
    snapshot.taskGraphs = [{
      ...graph,
      tasks: graph.tasks.map((task) => ({ ...task, scope: ['src/routing.ts'] })),
    }];

    expect(() => recordWorkOrderPreflightCommand(commandInput(snapshot))).toThrow(/L0/);
  });

  it('keeps completed and waived preflight events in the recognized control-event stream', () => {
    const started = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '路由工具',
      goal: '调整路由并补测试',
      now,
    });
    const taskGraph = snapshotFixture().taskGraphs![0];
    const snapshot = { ...started.snapshot, taskGraphs: [taskGraph] };
    const proposed: DomainEvent = {
      eventId: 'graph-1:proposed',
      streamId: 'project-1',
      sequence: 4,
      aggregateType: 'TaskGraph',
      aggregateId: 'graph-1',
      aggregateVersion: 1,
      eventType: 'TaskGraphProposed',
      schemaVersion: 1,
      payload: {
        taskGraphId: 'graph-1',
        sessionId: 'session-1',
        architectureId: 'architecture-1',
        graphVersion: 3,
        taskIds: ['task-1'],
      },
      actor: 'master',
      occurredAt: now,
      correlationId: 'session-1',
      source: { objectId: 'graph-1', objectVersion: 3 },
      sensitivity: 'private',
    };
    const completed = recordWorkOrderPreflightCommand(commandInput(snapshot)).events[0];
    const waived: DomainEvent<WorkOrderPreflightWaivedPayload> = {
      ...completed,
      eventId: 'preflight-1:waived',
      eventType: 'WorkOrderPreflightWaived',
      sequence: 6,
      aggregateVersion: 3,
      payload: {
        preflightId: 'preflight-1',
        taskGraphId: 'graph-1',
        taskId: 'task-1',
        graphVersion: 3,
        workOrderDigest: workOrderDigest(workOrderText),
        decisionId: 'decision-1',
        mode: 'shadow',
        createdAt: now,
      },
    };
    const events = [
      ...started.events,
      proposed,
      { ...completed, sequence: 5, aggregateVersion: 2 },
      waived,
    ];

    expect(auditProjectControlConsistency({ projectId: 'project-1', snapshot, events })).toMatchObject({
      ok: true,
      recognizedEventCount: 6,
      issues: [],
    });
  });
});
