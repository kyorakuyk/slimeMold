import { describe, expect, it } from 'vitest';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { graphGrowthProjection } from './graphGrowthProjection';
import {
  GRAPH_ID,
  PROJECT_ID,
  RUN_ID,
  SESSION_ID,
  eventStream,
  graph,
  nodeForAttempt,
  nodeForTask,
  task,
} from './graphGrowthProjectionTestUtils';

describe('graphGrowthProjection', () => {
  it('is deterministic at a sequence cutoff and rebuilds hierarchy and dependency edges', () => {
    const stream = eventStream();
    const value = graph(GRAPH_ID, [task('task-a', 'core'), task('task-b', 'ui', ['task-a'])]);
    stream.addGraph(value);
    stream.addQueued('task-a');
    stream.append('UnmodeledFutureEvent', 'FutureAggregate', 'future-1', { arbitrary: true });

    const atCutoff = graphGrowthProjection(stream.events, 2);
    const repeated = graphGrowthProjection(stream.events, 2);
    const live = stream.events.map((event, index) => (
      graphGrowthProjection(stream.events.slice(0, index + 1), event.sequence)
    )).at(-1)!;
    const replayed = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);

    expect(atCutoff).toEqual(repeated);
    expect(live).toEqual(replayed);
    expect(atCutoff.nodes.map(({ id, kind, status }) => ({ id, kind, status }))).toMatchSnapshot();
    expect(atCutoff.edges.map(({ id, sourceId, targetId, kind }) => ({ id, sourceId, targetId, kind }))).toMatchSnapshot();
    expect(nodeForTask(atCutoff, 'task-a')?.status).toBe('queued');
    expect(nodeForTask(atCutoff, 'task-b')?.status).toBe('idle');
    expect(atCutoff.edges.some((edge) => edge.kind === 'dependency'
      && edge.sourceId.endsWith('task-a') && edge.targetId.endsWith('task-b'))).toBe(true);
    expect(atCutoff.lastSequence).toBe(2);
  });

  it('projects queue, leased execution, feedback, blocking, evidence, failure, unknown, retry scars, and package markers', () => {
    const stream = eventStream();
    const value = graph(GRAPH_ID, [
      task('task-running', 'active'),
      task('task-unleased', 'active'),
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
    stream.addQueued('task-unleased');
    stream.addStarted('task-unleased', 1, RUN_ID, false);

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
    const unleased = nodeForTask(projection, 'task-unleased');
    const complete = nodeForTask(projection, 'task-complete');
    const feedback = nodeForTask(projection, 'task-feedback');
    const blocked = nodeForTask(projection, 'task-blocked');
    const failed = nodeForTask(projection, 'task-failed');
    const retryAttempt1 = createAttemptId(retryExecutionId, 1);
    const retryAttempt2 = createAttemptId(retryExecutionId, 2);

    expect(running).toMatchObject({ status: 'running', leaseHeld: true, pulse: true });
    expect(unleased).toMatchObject({ status: 'running', leaseHeld: false, pulse: false });
    expect(feedback?.status).toBe('waiting-feedback');
    expect(blocked?.status).toBe('blocked');
    expect(failed?.status).toBe('failed');
    expect(complete).toMatchObject({ status: 'succeeded', evidenceIds: ['evidence-task-complete-1'] });
    expect(complete?.eventIds).toContain(stream.events.find((event) => event.eventType === 'TaskSucceeded'
      && event.aggregateId === createTaskExecutionId(RUN_ID, 'task-complete'))?.eventId);
    const successEvent = stream.events.find((event) => event.eventType === 'TaskSucceeded'
      && event.aggregateId === createTaskExecutionId(RUN_ID, 'task-complete'))!;
    const completeModule = projection.nodes.find((node) => node.kind === 'module' && node.moduleId === 'complete');
    expect(projection.edges.find((edge) => edge.targetId === complete?.id)?.eventIds).toContain(successEvent.eventId);
    expect(projection.edges.find((edge) => edge.targetId === completeModule?.id)?.eventIds).toContain(successEvent.eventId);
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
    expect(projection.nodes.some((node) => node.id.includes('work-package-1'))).toBe(false);
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

  it('keeps earlier run attempts under the task while projecting the newest run status', () => {
    const stream = eventStream();
    stream.addGraph(graph(GRAPH_ID, [task('task-history', 'core')]));
    stream.addQueued('task-history', undefined, 'run-old');
    stream.addStarted('task-history', 1, 'run-old');
    stream.addFailed('task-history', 1, 'run-old');
    stream.addQueued('task-history', undefined, 'run-new');
    stream.addStarted('task-history', 1, 'run-new');
    stream.addSucceeded('task-history', 1, 'run-new');

    const projection = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);
    const oldAttempt = createAttemptId(createTaskExecutionId('run-old', 'task-history'), 1);
    const newAttempt = createAttemptId(createTaskExecutionId('run-new', 'task-history'), 1);

    expect(nodeForTask(projection, 'task-history')?.status).toBe('succeeded');
    expect(nodeForAttempt(projection, oldAttempt)?.status).toBe('failed');
    expect(nodeForAttempt(projection, oldAttempt)?.scar).toBe(true);
    expect(projection.scars).toContain(oldAttempt);
    expect(nodeForAttempt(projection, newAttempt)).toMatchObject({ status: 'succeeded', scar: false });
  });

  it('maps imported attempt provenance through its unique active task graph', () => {
    const stream = eventStream();
    stream.addGraph(graph(GRAPH_ID, [task('task-imported', 'core')]));
    const runId = 'run-imported';
    const taskId = 'task-imported';
    const taskExecutionId = createTaskExecutionId(runId, taskId);
    const attemptId = createAttemptId(taskExecutionId, 1);
    const imported = stream.append('TaskAttemptImported', 'TaskExecution', taskExecutionId, {
      runId,
      taskId,
      taskExecutionId,
      attempt: 1,
      attemptId,
      reason: 'legacy-worker-snapshot-without-attempt-history',
    }, {
      actor: 'system',
      sourceId: `${PROJECT_ID}:workerTask:${runId}:${taskId}`,
      correlationId: 'migration-imported',
      synthetic: true,
    });

    const projection = graphGrowthProjection(stream.events, imported.sequence);
    const attempt = nodeForAttempt(projection, attemptId);

    expect(attempt).toMatchObject({ graphId: GRAPH_ID, taskId, status: 'unknown' });
    expect(attempt?.eventIds).toContain(imported.eventId);
  });

  it('keeps a success annulus bound to TaskSucceeded after the task is cleaned', () => {
    const stream = eventStream();
    stream.addGraph(graph(GRAPH_ID, [task('task-cleaned', 'core')]));
    stream.addQueued('task-cleaned');
    stream.addStarted('task-cleaned');
    const success = stream.addSucceeded('task-cleaned');
    const taskExecutionId = createTaskExecutionId(RUN_ID, 'task-cleaned');
    const attemptId = createAttemptId(taskExecutionId, 1);
    stream.append('TaskCleaned', 'TaskExecution', taskExecutionId, {
      runId: RUN_ID,
      taskId: 'task-cleaned',
      taskExecutionId,
      attempt: 1,
      attemptId,
      receiptId: 'cleanup-receipt-task-cleaned',
      cleanupStatus: 'cleaned',
    }, { actor: 'user', sourceId: GRAPH_ID });

    const projection = graphGrowthProjection(stream.events, stream.events.at(-1)!.sequence);

    expect(projection.rings.find((ring) => ring.attemptId === attemptId)).toMatchObject({
      outcome: 'succeeded',
      eventId: success.eventId,
    });
  });
});
