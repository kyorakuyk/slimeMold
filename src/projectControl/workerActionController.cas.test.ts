import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types/orchestration';
import type { ProjectTaskGraph } from './types';
import { WorkerRecoveryDecisionPersistence } from './workerRecoveryDecisionPersistence';
import { createWorkerActionController } from './workerActionController';

const hostModules = vi.hoisted(() => {
  const events: unknown[] = [];
  return {
    events,
    load: vi.fn(async () => ({})),
    create: vi.fn(() => ({
      sideEffects: {
        recoverInterruptedRun: vi.fn(async () => ({ schemaVersion: 1 as const, entries: [] })),
      },
      createEventRepository: () => ({
        readStream: vi.fn(async () => ({ status: 'ok' as const, events, lastSequence: events.length })),
      }),
    })),
  };
});

vi.mock('./workerHostRepositoryBundle', () => ({
  loadWorkerHostRepositoryModules: hostModules.load,
  createWorkerHostRepositoryBundleFromModules: hostModules.create,
}));

const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
const attemptId = createAttemptId(taskExecutionId, 1);

const taskGraph: ProjectTaskGraph = {
  version: 1,
  id: 'graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 1,
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-22T00:00:00.000Z',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  tasks: [{
    version: 1,
    id: 'task-1',
    architectureId: 'architecture-1',
    title: '恢复任务',
    description: '恢复 durable decision',
    moduleId: 'module-1',
    scope: ['src/feature.ts'],
    dependsOn: [],
    acceptanceCriteria: ['测试通过'],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  }],
};

const run: WorkerRunQueueState = {
  version: 1,
  projectId: 'project-1',
  runId: 'run-1',
  orchestrationId: 'orch-1',
  taskGraphId: 'graph-1',
  taskGraphVersion: 1,
  status: 'failed',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:01:00.000Z',
  tasks: {
    'task-1': {
      taskId: 'task-1',
      taskExecutionId,
      currentAttemptId: attemptId,
      status: 'failed',
      attempt: 1,
      worktreeId: 'worktree-1',
      worktreePath: 'C:/project-workers/task-1',
      branch: 'worker/task-1',
      baseRevision: 'a'.repeat(40),
      taskDefinitionVersion: 1,
      evidenceIds: [],
      updatedAt: '2026-09-22T00:01:00.000Z',
      error: 'worker failed',
    },
  },
};

describe('worker action controller recovery CAS wiring', () => {
  it('persists one decision, repairs a missing projection, and does not rerun an exact request', async () => {
    hostModules.events.length = 0;
    const state = {
      projectId: 'project-1',
      projectPath: 'C:/project',
      workerRuns: [run],
      workerRunSideEffects: [],
      workerRunRecoveries: [],
      workerCleanupProposals: [],
      orchestrations: [{
        id: 'orch-1',
        status: 'failed',
        runIds: [],
        stageLogs: [],
        updatedAt: '2026-09-22T00:01:00.000Z',
      } as unknown as Orchestration],
      taskGraphs: [taskGraph],
      setWorkerRunSideEffects: vi.fn((effects) => { state.workerRunSideEffects = effects; }),
      setWorkerRuns: vi.fn((runs) => { state.workerRuns = runs; }),
      setOrchestrations: vi.fn((orchestrations) => { state.orchestrations = orchestrations; }),
      setWorkerCleanupProposals: vi.fn((proposals) => { state.workerCleanupProposals = proposals; }),
      setWorkerRunRecoveries: vi.fn((recoveries) => { state.workerRunRecoveries = recoveries; }),
    };
    const operation = { projectId: 'project-1', projectPath: 'C:/project', controller: new AbortController() };
    hostModules.events.push(
      {
        eventId: 'preexisting-run-event',
        streamId: 'project-1',
        sequence: 1,
        aggregateType: 'Run',
        aggregateId: 'run-1',
        aggregateVersion: 1,
        eventType: 'RunCreated',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskGraphId: 'graph-1', taskGraphVersion: 1 },
        actor: 'system',
        occurredAt: '2026-09-22T00:00:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-queued',
        streamId: 'project-1',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 1,
        eventType: 'TaskQueued',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, nextAttempt: 1 },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:00:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-started',
        streamId: 'project-1',
        sequence: 3,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 2,
        eventType: 'TaskStarted',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:00:30.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-failed',
        streamId: 'project-1',
        sequence: 4,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 3,
        eventType: 'TaskFailed',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId, error: 'worker failed' },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:01:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
    );
    const recordProjectEvents = vi.fn((_projectId, events: unknown[]) => {
      const existingAggregateVersions = new Map<string, number>();
      for (const event of hostModules.events as Array<{ aggregateType: string; aggregateId: string; aggregateVersion: number }>) {
        existingAggregateVersions.set(
          `${event.aggregateType}:${event.aggregateId}`,
          Math.max(existingAggregateVersions.get(`${event.aggregateType}:${event.aggregateId}`) ?? 0, event.aggregateVersion),
        );
      }
      let sequence = hostModules.events.length;
      const newEvents = (events as Array<Record<string, unknown>>).filter((event) => (
        !hostModules.events.some((existing) => (
          (existing as { eventId?: string }).eventId === event.eventId
        ))
      ));
      hostModules.events.push(...newEvents.map((event) => {
        const aggregateKey = `${String(event.aggregateType)}:${String(event.aggregateId)}`;
        const aggregateOffset = existingAggregateVersions.get(aggregateKey) ?? 0;
        const aggregateVersion = aggregateOffset + Number(event.aggregateVersion);
        return {
          ...event,
          sequence: ++sequence,
          aggregateVersion,
        };
      }));
    });
    const saveProject = vi.fn(async () => undefined);
    const runQueuedWorker = vi.fn(async () => undefined);
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'C:/project');
    const controller = createWorkerActionController({
      getState: () => state,
      getProjectOperation: () => operation,
      assertProjectOperation: vi.fn(),
      recordProjectEvents,
      saveProject,
      readProjectProjection: vi.fn(async () => ({
        workerRuns: state.workerRuns,
        orchestrations: state.orchestrations,
      })),
      runQueuedWorker,
      isTauri: true,
      ensureGuiDevSession: vi.fn(async () => ({
        listAcceptances: () => [],
      }) as never),
      recoveryDecisionPersistence: persistence,
    });

    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');
    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');
    state.workerRuns = [];
    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');

    expect(recordProjectEvents).toHaveBeenCalledTimes(2);
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(runQueuedWorker).toHaveBeenCalledTimes(1);
    expect(runQueuedWorker).toHaveBeenNthCalledWith(1, 'run-1', undefined, 'project-1', 'C:/project');
    await expect(persistence.read()).resolves.toMatchObject({
      status: 'ok',
      journal: { entries: [expect.objectContaining({ requestIdentity: 'request-1', status: 'committed' })] },
    });

    const durableRecord = await persistence.find('request-1');
    expect(durableRecord).toBeDefined();
    if (!durableRecord) throw new Error('durable recovery decision missing from test journal');
    const durableInput = {
      projectId: durableRecord.projectId,
      runId: durableRecord.runId,
      requestIdentity: durableRecord.requestIdentity,
      action: durableRecord.action,
      semanticPayloadVersion: durableRecord.semanticPayloadVersion,
      decisionId: durableRecord.decisionId,
      factsFingerprint: durableRecord.factsFingerprint,
      candidate: durableRecord.candidate,
      now: durableRecord.admittedAt,
    };
    const currentJournal = await persistence.read();
    if (currentJournal.status !== 'ok') throw new Error('test journal was not readable');
    await adapter.writeTextAtomic(persistence.path, JSON.stringify({
      schemaVersion: 1,
      entries: currentJournal.journal.entries.map((entry) => (
        entry.requestIdentity === 'request-1'
          ? { ...entry, postCommitStatus: 'failed' }
          : entry
      )),
    }));
    await expect(
      controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1'),
    ).rejects.toMatchObject({ code: 'needs-repair' });
    expect(runQueuedWorker).toHaveBeenCalledTimes(1);
    await expect(persistence.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ postCommitStatus: 'failed' })] },
    });
    runQueuedWorker.mockRejectedValueOnce(new Error('dispatch failed'));
    await expect(
      controller.retryFailedWorkerRecoveryPostCommit('run-1', 'request-1'),
    ).rejects.toThrow('dispatch failed');
    expect(runQueuedWorker).toHaveBeenCalledTimes(2);
    await expect(persistence.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ postCommitStatus: 'failed' })] },
    });
    await persistence.markPostCommit(durableInput, 'pending', durableRecord.admittedAt);
    runQueuedWorker.mockResolvedValueOnce(undefined);
    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');
    expect(runQueuedWorker).toHaveBeenCalledTimes(3);
    await expect(persistence.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ postCommitStatus: 'completed' })] },
    });

    state.workerRuns = [run];
    saveProject.mockImplementationOnce(async () => {
      state.workerRuns = [run];
    });
    await expect(
      controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1'),
    ).rejects.toMatchObject({ code: 'needs-repair' });
  });

  it('rejects a committed candidate whose task set no longer matches the trusted TaskGraph', async () => {
    hostModules.events.length = 0;
    const state = {
      projectId: 'project-1',
      projectPath: 'C:/project',
      workerRuns: [run],
      workerRunSideEffects: [],
      workerRunRecoveries: [],
      workerCleanupProposals: [],
      orchestrations: [{
        id: 'orch-1',
        status: 'failed',
        runIds: [],
        stageLogs: [],
        updatedAt: '2026-09-22T00:01:00.000Z',
      } as unknown as Orchestration],
      taskGraphs: [taskGraph],
      setWorkerRunSideEffects: vi.fn((effects) => { state.workerRunSideEffects = effects; }),
      setWorkerRuns: vi.fn((runs) => { state.workerRuns = runs; }),
      setOrchestrations: vi.fn((orchestrations) => { state.orchestrations = orchestrations; }),
      setWorkerCleanupProposals: vi.fn((proposals) => { state.workerCleanupProposals = proposals; }),
      setWorkerRunRecoveries: vi.fn((recoveries) => { state.workerRunRecoveries = recoveries; }),
    };
    const operation = { projectId: 'project-1', projectPath: 'C:/project', controller: new AbortController() };
    hostModules.events.push(
      {
        eventId: 'preexisting-run-event-graph-drift',
        streamId: 'project-1',
        sequence: 1,
        aggregateType: 'Run',
        aggregateId: 'run-1',
        aggregateVersion: 1,
        eventType: 'RunCreated',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskGraphId: 'graph-1', taskGraphVersion: 1 },
        actor: 'system',
        occurredAt: '2026-09-22T00:00:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-queued-graph-drift',
        streamId: 'project-1',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 1,
        eventType: 'TaskQueued',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, nextAttempt: 1 },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:00:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-started-graph-drift',
        streamId: 'project-1',
        sequence: 3,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 2,
        eventType: 'TaskStarted',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:00:30.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
      {
        eventId: 'preexisting-task-failed-graph-drift',
        streamId: 'project-1',
        sequence: 4,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 3,
        eventType: 'TaskFailed',
        schemaVersion: 1,
        payload: { runId: 'run-1', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId, error: 'worker failed' },
        actor: 'runtime',
        occurredAt: '2026-09-22T00:01:00.000Z',
        correlationId: 'run-1',
        source: { objectId: 'graph-1', objectVersion: 1 },
        sensitivity: 'normal',
      },
    );
    const recordProjectEvents = vi.fn((_projectId, events: unknown[]) => {
      const existingAggregateVersions = new Map<string, number>();
      for (const event of hostModules.events as Array<{ aggregateType: string; aggregateId: string; aggregateVersion: number }>) {
        existingAggregateVersions.set(
          `${event.aggregateType}:${event.aggregateId}`,
          Math.max(existingAggregateVersions.get(`${event.aggregateType}:${event.aggregateId}`) ?? 0, event.aggregateVersion),
        );
      }
      let sequence = hostModules.events.length;
      hostModules.events.push(...(events as Array<Record<string, unknown>>).map((event) => {
        const aggregateKey = `${String(event.aggregateType)}:${String(event.aggregateId)}`;
        return {
          ...event,
          sequence: ++sequence,
          aggregateVersion: (existingAggregateVersions.get(aggregateKey) ?? 0) + Number(event.aggregateVersion),
        };
      }));
    });
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'C:/project');
    const controller = createWorkerActionController({
      getState: () => state,
      getProjectOperation: () => operation,
      assertProjectOperation: vi.fn(),
      recordProjectEvents,
      saveProject: vi.fn(async () => undefined),
      readProjectProjection: vi.fn(async () => ({ workerRuns: state.workerRuns, orchestrations: state.orchestrations })),
      runQueuedWorker: vi.fn(async () => undefined),
      isTauri: true,
      ensureGuiDevSession: vi.fn(async () => ({ listAcceptances: () => [] }) as never),
      recoveryDecisionPersistence: persistence,
    });

    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-graph-drift');
    const appliedRuns = JSON.parse(JSON.stringify(state.workerRuns));
    const journal = await persistence.read();
    if (journal.status !== 'ok') throw new Error('test journal was not readable');
    const original = journal.journal.entries[0];
    await adapter.writeTextAtomic(persistence.path, JSON.stringify({
      schemaVersion: 1,
      entries: journal.journal.entries.map((entry) => entry.requestIdentity === 'request-graph-drift'
        ? {
            ...entry,
            candidate: {
              ...entry.candidate,
              taskGraphTaskIds: [],
              state: { ...entry.candidate.state, tasks: {} },
              events: [entry.candidate.events[0]],
            },
          }
        : entry),
    }));

    await expect(
      controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-graph-drift'),
    ).rejects.toMatchObject({ code: 'needs-repair' });
    expect(state.workerRuns).toEqual(appliedRuns);
    expect(original.candidate.state.tasks).toHaveProperty('task-1');
  });
});
