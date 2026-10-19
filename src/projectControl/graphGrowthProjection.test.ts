import { describe, expect, it } from 'vitest';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { DomainEvent } from '../domain/contracts';
import type { ProjectTask, ProjectTaskGraph } from './types';
import { graphGrowthProjection } from './graphGrowthProjection';

const PROJECT_ID = 'project-live-graph';
const SESSION_ID = 'session-live-graph';
const GRAPH_ID = 'graph-live-graph';
const RUN_ID = 'run-live-graph';

function task(id: string, moduleId: string, dependsOn: string[] = []): ProjectTask {
  return {
    version: 1,
    id,
    architectureId: 'architecture-live-graph',
    title: `Title ${id}`,
    description: `Description ${id}`,
    moduleId,
    scope: [`src/${id}.ts`],
    dependsOn,
    acceptanceCriteria: [`acceptance ${id}`],
    category: 'logic',
    status: 'approved',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function graph(id = GRAPH_ID, tasks: ProjectTask[] = [task('task-a', 'core')], graphVersion = 1): ProjectTaskGraph {
  return {
    version: 1,
    id,
    sessionId: SESSION_ID,
    architectureId: 'architecture-live-graph',
    graphVersion,
    tasks,
    approval: 'approved',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function eventStream() {
  const events: DomainEvent[] = [];
  const aggregateVersions = new Map<string, number>();
  const append = (
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    options: {
      actor?: DomainEvent['actor'];
      sourceId?: string;
      sourceVersion?: number;
    } = {},
  ): DomainEvent => {
    const aggregateKey = `${aggregateType}\u0000${aggregateId}`;
    const aggregateVersion = (aggregateVersions.get(aggregateKey) ?? 0) + 1;
    aggregateVersions.set(aggregateKey, aggregateVersion);
    const sequence = events.length + 1;
    const event: DomainEvent = {
      eventId: `event-${sequence}-${eventType}`,
      streamId: PROJECT_ID,
      sequence,
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventType,
      schemaVersion: 1,
      payload,
      actor: options.actor ?? 'runtime',
      occurredAt: `2026-10-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(options.sourceId ? {
        source: { objectId: options.sourceId, objectVersion: options.sourceVersion ?? 1 },
      } : {}),
    };
    events.push(event);
    return event;
  };
  const addGraph = (value: ProjectTaskGraph, eventType = 'TaskGraphProposed'): DomainEvent => append(
    eventType,
    'TaskGraph',
    value.id,
    {
      taskGraphId: value.id,
      sessionId: value.sessionId,
      architectureId: value.architectureId,
      graphVersion: value.graphVersion,
      taskIds: value.tasks.map((item) => item.id),
      graph: value,
    },
    { actor: 'master', sourceId: value.id, sourceVersion: value.graphVersion },
  );
  const addQueued = (taskId: string, nextAttempt?: number): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(RUN_ID, taskId);
    return append(
      'TaskQueued',
      'TaskExecution',
      taskExecutionId,
      {
        runId: RUN_ID,
        taskId,
        taskExecutionId,
        taskGraphId: GRAPH_ID,
        ...(nextAttempt ? { nextAttempt } : {}),
      },
      { sourceId: GRAPH_ID },
    );
  };
  const addStarted = (taskId: string, attempt = 1): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(RUN_ID, taskId);
    const attemptId = createAttemptId(taskExecutionId, attempt);
    return append(
      'TaskStarted',
      'TaskExecution',
      taskExecutionId,
      {
        runId: RUN_ID,
        taskId,
        taskExecutionId,
        attemptId,
        attempt,
        worktreeId: `worktree-${taskId}-${attempt}`,
        worktreePath: `C:/worktrees/${taskId}-${attempt}`,
        branch: `worker/${taskId}-${attempt}`,
        baseRevision: 'base-revision',
        worktreeStatus: 'created',
      },
      { sourceId: GRAPH_ID },
    );
  };
  const addSucceeded = (taskId: string, attempt = 1): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(RUN_ID, taskId);
    return append(
      'TaskSucceeded',
      'TaskExecution',
      taskExecutionId,
      {
        runId: RUN_ID,
        taskId,
        taskExecutionId,
        attemptId: createAttemptId(taskExecutionId, attempt),
        attempt,
        evidenceIds: [`evidence-${taskId}-${attempt}`],
        acceptanceId: `acceptance-${taskId}-${attempt}`,
      },
      { sourceId: GRAPH_ID },
    );
  };
  return { events, append, addGraph, addQueued, addStarted, addSucceeded };
}

function nodeForTask(
  projection: ReturnType<typeof graphGrowthProjection>,
  taskId: string,
) {
  return projection.nodes.find((node) => node.kind === 'task' && node.taskId === taskId);
}

function nodeForAttempt(
  projection: ReturnType<typeof graphGrowthProjection>,
  attemptId: string,
) {
  return projection.nodes.find((node) => node.kind === 'attempt' && node.attemptId === attemptId);
}

describe('graphGrowthProjection', () => {
  it('is deterministic at a sequence cutoff and rebuilds hierarchy and dependency edges', () => {
    const stream = eventStream();
    const value = graph(GRAPH_ID, [task('task-a', 'core'), task('task-b', 'ui', ['task-a'])]);
    stream.addGraph(value);
    stream.addQueued('task-a');
    stream.append('UnmodeledFutureEvent', 'FutureAggregate', 'future-1', { arbitrary: true });

    const atCutoff = graphGrowthProjection(stream.events, 2);
    const repeated = graphGrowthProjection(stream.events, 2);
    const live = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);

    expect(atCutoff).toEqual(repeated);
    expect(live).toEqual(graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence));
    expect(atCutoff.nodes.map(({ id, kind, status }) => ({ id, kind, status }))).toMatchSnapshot();
    expect(atCutoff.edges.map(({ id, sourceId, targetId, kind }) => ({ id, sourceId, targetId, kind }))).toMatchSnapshot();
    expect(nodeForTask(atCutoff, 'task-a')?.status).toBe('queued');
    expect(nodeForTask(atCutoff, 'task-b')?.status).toBe('queued');
    expect(atCutoff.edges.some((edge) => edge.kind === 'dependency'
      && edge.sourceId.endsWith('task-a') && edge.targetId.endsWith('task-b'))).toBe(true);
    expect(atCutoff.lastSequence).toBe(2);
  });

  it('projects queue, leased execution, feedback, blocking, evidence, failure, unknown, retry scars, and package markers', () => {
    const stream = eventStream();
    const value = graph(GRAPH_ID, [
      task('task-running', 'active'),
      task('task-feedback', 'waiting'),
      task('task-blocked', 'blocked'),
      task('task-failed', 'failed'),
      task('task-unknown', 'unknown'),
      task('task-complete', 'complete'),
      task('task-retry', 'retry'),
    ]);
    stream.addGraph(value);

    stream.addQueued('task-running');
    stream.addStarted('task-running');

    stream.addQueued('task-feedback');
    stream.addStarted('task-feedback');
    const feedbackExecutionId = createTaskExecutionId(RUN_ID, 'task-feedback');
    stream.append('TaskFeedbackRequested', 'TaskExecution', feedbackExecutionId, {
      runId: RUN_ID,
      taskId: 'task-feedback',
      taskExecutionId: feedbackExecutionId,
      attemptId: createAttemptId(feedbackExecutionId, 1),
      attempt: 1,
      feedbackId: 'feedback-1',
      blocking: true,
    }, { sourceId: GRAPH_ID });

    stream.addQueued('task-blocked');
    const blockedExecutionId = createTaskExecutionId(RUN_ID, 'task-blocked');
    stream.append('TaskBlocked', 'TaskExecution', blockedExecutionId, {
      runId: RUN_ID,
      taskId: 'task-blocked',
      taskExecutionId: blockedExecutionId,
      blockedBy: ['task-running'],
      reason: 'dependency pending',
    }, { sourceId: GRAPH_ID });

    stream.addQueued('task-failed');
    stream.addStarted('task-failed');
    const failedExecutionId = createTaskExecutionId(RUN_ID, 'task-failed');
    stream.append('TaskFailed', 'TaskExecution', failedExecutionId, {
      runId: RUN_ID,
      taskId: 'task-failed',
      taskExecutionId: failedExecutionId,
      attemptId: createAttemptId(failedExecutionId, 1),
      attempt: 1,
      error: 'fixture failure',
    }, { sourceId: GRAPH_ID });

    stream.addQueued('task-unknown');
    stream.addStarted('task-unknown');
    const unknownExecutionId = createTaskExecutionId(RUN_ID, 'task-unknown');
    stream.append('TaskAttemptMarkedUnknown', 'TaskExecution', unknownExecutionId, {
      runId: RUN_ID,
      taskId: 'task-unknown',
      taskExecutionId: unknownExecutionId,
      attemptId: createAttemptId(unknownExecutionId, 1),
      attempt: 1,
      reason: 'process exited without receipt',
    }, { actor: 'user', sourceId: GRAPH_ID });

    stream.addQueued('task-complete');
    stream.addStarted('task-complete');
    stream.addSucceeded('task-complete');

    stream.addQueued('task-retry');
    stream.addStarted('task-retry');
    const retryExecutionId = createTaskExecutionId(RUN_ID, 'task-retry');
    stream.append('TaskFailed', 'TaskExecution', retryExecutionId, {
      runId: RUN_ID,
      taskId: 'task-retry',
      taskExecutionId: retryExecutionId,
      attemptId: createAttemptId(retryExecutionId, 1),
      attempt: 1,
      error: 'first attempt failed',
    }, { sourceId: GRAPH_ID });
    stream.addQueued('task-retry', 2);
    stream.addStarted('task-retry', 2);

    stream.append('DepartmentWorkPackageDispatched', 'DepartmentWorkPackage', 'work-package-1', {
      workPackageId: 'work-package-1',
      planId: 'plan-1',
      planVersion: 1,
      departmentCharterId: 'charter-1',
      taskGraphId: GRAPH_ID,
      milestoneIds: ['milestone-1'],
    }, { actor: 'master' });
    stream.append('UnmodeledFutureEvent', 'FutureAggregate', 'future-2', { arbitrary: true });

    const projection = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);
    const running = nodeForTask(projection, 'task-running');
    const complete = nodeForTask(projection, 'task-complete');
    const feedback = nodeForTask(projection, 'task-feedback');
    const blocked = nodeForTask(projection, 'task-blocked');
    const failed = nodeForTask(projection, 'task-failed');
    const unknownExecution = createTaskExecutionId(RUN_ID, 'task-unknown');
    const retryAttempt1 = createAttemptId(retryExecutionId, 1);
    const retryAttempt2 = createAttemptId(retryExecutionId, 2);

    expect(running).toMatchObject({ status: 'running', leaseHeld: true, pulse: true });
    expect(feedback?.status).toBe('waiting-feedback');
    expect(blocked?.status).toBe('blocked');
    expect(failed?.status).toBe('failed');
    expect(complete).toMatchObject({ status: 'succeeded', evidenceIds: ['evidence-task-complete-1'] });
    expect(nodeForAttempt(projection, createAttemptId(unknownExecutionId, 1))?.status).toBe('unknown');
    expect(nodeForAttempt(projection, retryAttempt1)?.scar).toBe(true);
    expect(nodeForAttempt(projection, retryAttempt2)).toBeDefined();
    expect(projection.rings.some((ring) => ring.attemptId === createAttemptId(failedExecutionId, 1)
      && ring.outcome === 'failed')).toBe(true);
    expect(projection.flow.some((flow) => flow.taskId === 'task-complete' && flow.count === 1)).toBe(true);
    expect(projection.capsules.some((capsule) => capsule.moduleId === 'complete'
      && capsule.completionBasis === 'evidence-backed')).toBe(true);
    expect(projection.markers.some((marker) => marker.eventType === 'DepartmentWorkPackageDispatched'
      && marker.eventId === 'event-' + stream.events.at(-2)!.sequence + '-DepartmentWorkPackageDispatched')).toBe(true);
    expect(projection.nodes.some((node) => node.kind === 'work-package')).toBe(false);
    expect(projection.nodes.map(({ id, kind, status, scar }) => ({ id, kind, status, scar }))).toMatchSnapshot();
    expect(projection.rings).toMatchSnapshot();
  });

  it('uses the latest graph revision at each cutoff without duplicating superseded tasks', () => {
    const stream = eventStream();
    const original = graph('graph-original', [task('task-a', 'core')], 1);
    const revision = {
      ...graph('graph-revision', [task('task-a', 'core'), task('task-b', 'ui', ['task-a'])], 2),
      revisionOf: original.id,
    };
    stream.addGraph(original);
    stream.append('TaskGraphSuperseded', 'TaskGraph', original.id, {
      taskGraphId: original.id,
      supersededBy: revision.id,
      graphVersion: original.graphVersion,
      graph: { ...original, approval: 'superseded', supersededBy: revision.id },
    }, { actor: 'user', sourceId: original.id });
    stream.addGraph(revision, 'TaskGraphRevisionCreated');
    stream.append('SessionTaskGraphLinked', 'Session', SESSION_ID, {
      sessionId: SESSION_ID,
      taskGraphId: revision.id,
      revisionOf: original.id,
    }, { actor: 'user', sourceId: SESSION_ID });

    const beforeRevision = graphGrowthProjection(stream.events, 1);
    const afterRevision = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);

    expect(nodeForTask(beforeRevision, 'task-a')?.graphId).toBe(original.id);
    expect(nodeForTask(beforeRevision, 'task-b')).toBeUndefined();
    expect(nodeForTask(afterRevision, 'task-a')?.graphId).toBe(revision.id);
    expect(nodeForTask(afterRevision, 'task-b')?.graphId).toBe(revision.id);
    expect(afterRevision.nodes.filter((node) => node.kind === 'task' && node.taskId === 'task-a')).toHaveLength(1);
  });
});
