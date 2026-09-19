import { describe, expect, it } from 'vitest';
import {
  createWorkerRunQueue,
  runWorkerQueue,
} from '../domain/workerQueue';
import type { DomainEvent } from '../domain/contracts';
import type { ProjectTaskGraph } from './types';
import {
  rehydrateWorkerRunsFromEvents,
  reconcileWorkerRunsFromEvents,
  restoreMissingWorkerRunsFromEvents,
} from './workerRunRehydration';

const graph: ProjectTaskGraph = {
  version: 1,
  id: 'graph-rehydrate-1',
  sessionId: 'session-rehydrate-1',
  architectureId: 'architecture-rehydrate-1',
  graphVersion: 1,
  tasks: [{
    version: 1,
    id: 'task-marker',
    architectureId: 'architecture-rehydrate-1',
    title: '生成 marker',
    description: '生成 marker 文件',
    moduleId: 'module-1',
    scope: ['docs/WORKER_E2E_OK.txt'],
    dependsOn: [],
    acceptanceCriteria: ['marker 存在'],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  }],
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-15T00:00:00.000Z',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

describe('rehydrateWorkerRunsFromEvents', () => {
  it('rebuilds a partial Run and its failed Attempt when the ProjectFile projection is empty', async () => {
    const runId = 'run-rehydrate-1';
    const queue = createWorkerRunQueue({
      projectId: 'project-rehydrate-1',
      runId,
      orchestrationId: 'orch-rehydrate-1',
      taskGraph: graph,
      now: '2026-09-15T00:00:00.000Z',
    });
    const events = queue.drainEvents();

    await runWorkerQueue(queue, {
      allocator: {
        allocate: async () => ({
          worktreeId: 'worker-wt-1',
          path: 'D:/Temp/project-workers/worker-wt-1',
          branch: 'worker/worker-wt-1',
          baseRevision: '3be065ee082a5c4c10c1c3f0c11226154485b1f5',
        }),
      },
      executor: {
        execute: async () => ({ status: 'failed', error: 'acceptance failed' }),
      },
      onTransition: ({ events: transitionEvents }) => {
        events.push(...transitionEvents);
      },
    });

    const result = rehydrateWorkerRunsFromEvents({
      projectId: 'project-rehydrate-1',
      events,
      taskGraphs: [graph],
      existingRuns: [],
    });

    expect(result.issues).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      runId,
      status: 'partial',
      orchestrationId: 'orch-rehydrate-1',
    });
    expect(result.runs[0].tasks['task-marker']).toMatchObject({
      status: 'failed',
      attempt: 1,
      currentAttemptId: 'task-execution:run-rehydrate-1:task-marker:attempt-1',
      worktreeId: 'worker-wt-1',
      worktreePath: 'D:/Temp/project-workers/worker-wt-1',
      branch: 'worker/worker-wt-1',
      baseRevision: '3be065ee082a5c4c10c1c3f0c11226154485b1f5',
      worktreeStatus: 'created',
      error: 'acceptance failed',
    });

    const restored = restoreMissingWorkerRunsFromEvents({
      projectId: 'project-rehydrate-1',
      events,
      taskGraphs: [graph],
      existingRuns: [],
    });
    expect(restored).toMatchObject({ restored: true, issues: [] });
    expect(restored.runs).toHaveLength(1);
  });

  it('quarantines a TaskSucceeded event that lacks Acceptance provenance', async () => {
    const runId = 'run-rehydrate-invalid-success';
    const queue = createWorkerRunQueue({
      projectId: 'project-rehydrate-1',
      runId,
      orchestrationId: 'orch-rehydrate-1',
      taskGraph: graph,
      now: '2026-09-15T00:00:00.000Z',
    });
    const events: DomainEvent[] = queue.drainEvents();
    await runWorkerQueue(queue, {
      allocator: {
        allocate: async () => ({
          worktreeId: 'worker-wt-invalid',
          path: 'D:/Temp/project-workers/worker-wt-invalid',
          branch: 'worker/worker-wt-invalid',
          baseRevision: '3be065ee082a5c4c10c1c3f0c11226154485b1f5',
        }),
      },
      executor: {
        execute: async () => ({
          status: 'succeeded' as const,
          evidenceIds: ['evidence-invalid'],
          acceptanceId: 'acceptance-invalid',
        }),
      },
      onTransition: ({ events: transitionEvents }) => {
        events.push(...transitionEvents);
      },
    });
    const invalidEvents = events.map((event) => event.eventType === 'TaskSucceeded'
      ? {
          ...event,
          payload: {
            ...(event.payload as Record<string, unknown>),
            acceptanceId: undefined,
          },
        }
      : event);

    const result = rehydrateWorkerRunsFromEvents({
      projectId: 'project-rehydrate-1',
      events: invalidEvents,
      taskGraphs: [graph],
      existingRuns: [],
    });

    expect(result.issues.some((issue) => /Acceptance|provenance/.test(issue.message))).toBe(true);
    expect(result.runs[0].status).not.toBe('succeeded');
  });

  it('reconciles a stale ProjectFile snapshot with a durable retry fence', () => {
    const run = createWorkerRunQueue({
      projectId: 'project-rehydrate-1',
      runId: 'run-rehydrate-retry',
      taskGraph: graph,
      now: '2026-09-15T00:00:00.000Z',
    }).snapshot();
    const taskExecutionId = 'task-execution:run-rehydrate-retry:task-marker';
    const stale = {
      ...run,
      status: 'partial' as const,
      tasks: {
        ...run.tasks,
        'task-marker': {
          ...run.tasks['task-marker'],
          taskExecutionId,
          status: 'failed' as const,
          attempt: 1,
          currentAttemptId: `${taskExecutionId}:attempt-1`,
          worktreeId: 'old-worktree',
          worktreePath: 'D:/old-worktree',
          branch: 'worker/old-worktree',
          baseRevision: 'base-1',
          evidenceIds: ['old-evidence'],
          acceptanceId: 'old-acceptance',
          error: 'old failure',
          updatedAt: '2026-09-15T00:01:00.000Z',
        },
      },
    };
    const events = [
      {
        eventId: 'retry-run-queued',
        streamId: 'project-rehydrate-1',
        sequence: 1,
        aggregateType: 'Run',
        aggregateId: stale.runId,
        aggregateVersion: 1,
        eventType: 'RunQueued',
        schemaVersion: 1,
        payload: { runId: stale.runId },
        actor: 'user' as const,
        occurredAt: '2026-09-15T00:02:00.000Z',
        correlationId: stale.runId,
        source: { objectId: graph.id, objectVersion: graph.graphVersion },
        sensitivity: 'normal' as const,
      },
      {
        eventId: 'retry-task-queued',
        streamId: 'project-rehydrate-1',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 1,
        eventType: 'TaskQueued',
        schemaVersion: 1,
        payload: {
          runId: stale.runId,
          taskId: 'task-marker',
          taskExecutionId,
          nextAttempt: 2,
        },
        actor: 'user' as const,
        occurredAt: '2026-09-15T00:02:00.000Z',
        correlationId: stale.runId,
        source: { objectId: graph.id, objectVersion: graph.graphVersion },
        sensitivity: 'normal' as const,
      },
    ];

    const result = reconcileWorkerRunsFromEvents({
      projectId: 'project-rehydrate-1',
      events,
      runs: [stale],
    });

    expect(result.issues).toEqual([]);
    expect(result.changedRunIds).toEqual([stale.runId]);
    expect(result.runs[0]).toMatchObject({ status: 'queued' });
    expect(result.runs[0].tasks['task-marker']).toMatchObject({
      status: 'queued',
      attempt: 1,
      pendingAttempt: 2,
      evidenceIds: [],
    });
    expect(result.runs[0].tasks['task-marker'].worktreePath).toBeUndefined();
    expect(result.runs[0].tasks['task-marker'].currentAttemptId).toBeUndefined();
  });
});
