import { describe, expect, it } from 'vitest';
import {
  approveTaskGraphCommand,
  generateTaskGraphCommand,
  reviseTaskGraphCommand,
} from './commands';
import { replayTaskGraphsFromEvents } from './taskGraphEventReplay';
import type { DomainEvent } from '../domain/contracts';
import type { ProjectControlSnapshot, ProjectTaskGraph } from './types';

function approvedArchitectureSnapshot(): ProjectControlSnapshot {
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
      architectureId: 'architecture-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    decisions: [],
    briefs: [],
    architectures: [{
      version: 1,
      id: 'architecture-1',
      sessionId: 'session-1',
      briefId: 'brief-1',
      architectureVersion: 1,
      overview: '分层架构',
      modules: [],
      interfaces: [],
      tasks: [{
        id: 'task-1',
        title: '实现任务',
        description: '实现最小功能',
        moduleId: 'core',
        scope: ['src/core.ts'],
        dependsOn: [],
        acceptanceCriteria: ['测试通过'],
        category: 'logic',
      }],
      risks: [],
      approval: 'approved',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    issues: [],
  };
}

function graph(id: string): ProjectTaskGraph {
  return {
    version: 1,
    id,
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 1,
    tasks: [{
      version: 1,
      id: `${id}-task`,
      architectureId: 'architecture-1',
      title: '实现任务',
      description: '实现最小功能',
      moduleId: 'core',
      scope: ['src/core.ts'],
      dependsOn: [],
      acceptanceCriteria: ['测试通过'],
      category: 'logic',
      status: 'proposed',
      createdAt: '2026-09-01T00:03:00.000Z',
      updatedAt: '2026-09-01T00:03:00.000Z',
    }],
    approval: 'draft',
    createdAt: '2026-09-01T00:03:00.000Z',
    updatedAt: '2026-09-01T00:03:00.000Z',
  };
}

function graphEvent(
  eventId: string,
  eventType: string,
  graphId: string,
  payload: unknown,
): DomainEvent {
  return {
    eventId,
    streamId: 'project-1',
    sequence: 1,
    aggregateType: 'TaskGraph',
    aggregateId: graphId,
    aggregateVersion: 1,
    eventType,
    schemaVersion: 1,
    payload,
    actor: 'user',
    occurredAt: '2026-09-01T00:03:00.000Z',
  };
}

describe('replayTaskGraphsFromEvents', () => {
  it('reconstructs proposals, revisions, approval, and supersession from command events', () => {
    const proposed = generateTaskGraphCommand({
      snapshot: approvedArchitectureSnapshot(),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });
    const revised = reviseTaskGraphCommand({
      snapshot: proposed.snapshot,
      sessionId: 'session-1',
      sourceTaskGraphId: 'task-graph-1',
      id: 'task-graph-2',
      now: '2026-09-01T00:04:00.000Z',
      changes: [{ taskId: 'task-1', title: '修订任务' }],
    });
    const approved = approveTaskGraphCommand({
      snapshot: revised.snapshot,
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:05:00.000Z',
    });
    const events = [...proposed.events, ...revised.events, ...approved.events];

    const replayed = replayTaskGraphsFromEvents(events);

    expect(replayed.graphs).toEqual(approved.snapshot.taskGraphs);
    expect(replayed.legacyGraphIds).toEqual([]);
    expect(replayTaskGraphsFromEvents([...events, ...events])).toEqual(replayed);
    expect(events.filter((event) => [
      'TaskGraphProposed',
      'TaskGraphRevisionCreated',
      'TaskGraphApproved',
      'TaskGraphSuperseded',
    ].includes(event.eventType)).every((event) => {
      return typeof event.payload === 'object'
        && event.payload !== null
        && 'graph' in event.payload;
    })).toBe(true);
  });

  it('marks taskIds-only legacy events until a complete graph snapshot appears', () => {
    const taskGraph = graph('legacy-graph');
    const legacyProposal = graphEvent('legacy-proposal', 'TaskGraphProposed', taskGraph.id, {
      taskGraphId: taskGraph.id,
      taskIds: [taskGraph.tasks[0].id],
    });
    const legacyImport = graphEvent('legacy-import', 'LegacyTaskGraphImported', taskGraph.id, {
      id: taskGraph.id,
      graphVersion: taskGraph.graphVersion,
      approval: taskGraph.approval,
      taskIds: [taskGraph.tasks[0].id],
    });
    const fullRevision = graphEvent('full-revision', 'TaskGraphRevisionCreated', taskGraph.id, {
      taskGraphId: taskGraph.id,
      graph: taskGraph,
    });

    expect(replayTaskGraphsFromEvents([legacyProposal, legacyImport])).toEqual({
      graphs: [],
      legacyGraphIds: [taskGraph.id],
    });
    expect(replayTaskGraphsFromEvents([legacyProposal, fullRevision])).toEqual({
      graphs: [taskGraph],
      legacyGraphIds: [],
    });
    expect(replayTaskGraphsFromEvents([fullRevision, legacyProposal])).toEqual({
      graphs: [],
      legacyGraphIds: [taskGraph.id],
    });
    expect(replayTaskGraphsFromEvents([
      graphEvent('full-import', 'LegacyTaskGraphImported', taskGraph.id, {
        id: taskGraph.id,
        graph: taskGraph,
      }),
    ])).toEqual({ graphs: [taskGraph], legacyGraphIds: [] });
  });

  it('preserves first-seen graph order and rejects incomplete snapshots as legacy', () => {
    const laterGraph = graph('graph-b');
    const earlierGraph = graph('graph-a');
    const first = graphEvent('first', 'TaskGraphProposed', laterGraph.id, {
      taskGraphId: laterGraph.id,
      graph: laterGraph,
    });
    const second = graphEvent('second', 'TaskGraphProposed', earlierGraph.id, {
      taskGraphId: earlierGraph.id,
      graph: earlierGraph,
    });
    const incomplete = graphEvent('incomplete', 'TaskGraphApproved', 'incomplete-graph', {
      taskGraphId: 'incomplete-graph',
      graph: { id: 'incomplete-graph', tasks: [] },
    });

    expect(replayTaskGraphsFromEvents([first, second, incomplete])).toEqual({
      graphs: [laterGraph, earlierGraph],
      legacyGraphIds: ['incomplete-graph'],
    });
  });
});
