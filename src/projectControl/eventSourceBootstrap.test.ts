import { beforeEach, describe, expect, it } from 'vitest';
import { replayDomainEvents, type DomainEvent } from '../domain/contracts';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { EventStreamRepository, InMemoryEventStoreAdapter } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { createEmptyProjectControlSnapshot } from './persistence';
import { ensureProjectControlEventBaseline } from './eventSourceBootstrap';

let adapter: InMemoryEventStoreAdapter;
let repository: EventStreamRepository;

beforeEach(() => {
  adapter = new InMemoryEventStoreAdapter();
  repository = new EventStreamRepository(adapter, 'project-root');
});

function event(): DomainEvent {
  return {
    eventId: 'existing-event',
    streamId: 'project-1',
    sequence: 1,
    aggregateType: 'Project',
    aggregateId: 'project-1',
    aggregateVersion: 1,
    eventType: 'ProjectCreated',
    schemaVersion: 1,
    payload: { projectId: 'project-1' },
    actor: 'user',
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('project control event source bootstrap', () => {
  it('imports an empty legacy control snapshot as a synthetic baseline', async () => {
    const snapshot = createEmptyProjectControlSnapshot();
    const result = await ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot,
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.migrated).toBe(true);
    expect(result.stream.events[0]).toMatchObject({
      eventType: 'ProjectControlBaselineImported',
      synthetic: true,
    });
    await expect(repository.loadProjection()).resolves.toMatchObject({
      status: 'ok',
      source: 'snapshot',
    });
  });

  it('does not write a second baseline on a non-empty event stream', async () => {
    await repository.append(event(), 0);
    const result = await ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.migrated).toBe(false);
    expect(result.stream.events).toEqual([event()]);
  });

  it('imports legacy Worker runs into the synthetic baseline for replay', async () => {
    const workerRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-legacy',
      orchestrationId: 'orch-1',
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
          currentAttemptId: 'task-execution:run-legacy:task-1:attempt-1',
          evidenceIds: ['evidence-1'],
          acceptanceId: 'acceptance-1',
          worktreeId: 'worktree-1',
          worktreePath: 'C:/worktrees/task-1',
          branch: 'worker/task-1',
          baseRevision: 'base-1',
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    };
    const result = await ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      workerRuns: [workerRun],
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.stream.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'RunSucceeded', synthetic: true }),
      expect.objectContaining({ eventType: 'TaskSucceeded', aggregateType: 'TaskExecution', synthetic: true }),
    ]));
    const loaded = await repository.loadProjection();
    expect(loaded.projection?.taskExecutions[createTaskExecutionId('run-legacy', 'task-1')]).toMatchObject({
      status: 'succeeded',
      attemptIds: ['task-execution:run-legacy:task-1:attempt-1'],
    });
  });

  it('imports queued retry history without inventing a terminal outcome', async () => {
    const workerRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-legacy-retry',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'queued',
          attempt: 1,
          evidenceIds: [],
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    };
    const result = await ensureProjectControlEventBaseline({
      repository: new EventStreamRepository(new InMemoryEventStoreAdapter(), 'project-root'),
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      workerRuns: [workerRun],
      now: '2026-09-01T00:02:00.000Z',
      migrationId: 'legacy-retry-migration',
    });

    const loaded = await result.stream;
    const projection = replayDomainEvents(loaded.events);
    const taskExecutionId = createTaskExecutionId('run-legacy-retry', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    expect(projection.taskExecutions[taskExecutionId]).toMatchObject({ status: 'queued', attemptIds: [attemptId] });
    expect(projection.attempts[attemptId]).toMatchObject({ status: 'unknown', attempt: 1 });
  });

  it('fails closed when the existing stream needs repair', async () => {
    await adapter.writeTextAtomic(repository.eventsPath, '{broken');

    await expect(ensureProjectControlEventBaseline({
      repository,
      projectId: 'project-1',
      snapshot: createEmptyProjectControlSnapshot(),
      now: '2026-09-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'needs-repair' });
  });
});
