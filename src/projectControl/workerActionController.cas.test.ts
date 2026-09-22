import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import { WorkerRecoveryDecisionPersistence } from './workerRecoveryDecisionPersistence';
import { createWorkerActionController } from './workerActionController';

const hostModules = vi.hoisted(() => ({
  load: vi.fn(async () => ({})),
  create: vi.fn(() => ({
    sideEffects: {
      recoverInterruptedRun: vi.fn(async () => ({ schemaVersion: 1 as const, entries: [] })),
    },
  })),
}));

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
  it('persists one decision and does not rerun an exact request after replay', async () => {
    const state = {
      projectId: 'project-1',
      projectPath: 'C:/project',
      workerRuns: [run],
      workerRunSideEffects: [],
      workerRunRecoveries: [],
      workerCleanupProposals: [],
      orchestrations: [],
      taskGraphs: [taskGraph],
      setWorkerRunSideEffects: vi.fn(),
      setWorkerRuns: vi.fn(),
      setOrchestrations: vi.fn(),
      setWorkerCleanupProposals: vi.fn(),
      setWorkerRunRecoveries: vi.fn(),
    };
    const operation = { projectId: 'project-1', projectPath: 'C:/project', controller: new AbortController() };
    const recordProjectEvents = vi.fn();
    const saveProject = vi.fn(async () => undefined);
    const runQueuedWorker = vi.fn(async () => undefined);
    const persistence = new WorkerRecoveryDecisionPersistence(new InMemoryEventStoreAdapter(), 'C:/project');
    const controller = createWorkerActionController({
      getState: () => state,
      getProjectOperation: () => operation,
      assertProjectOperation: vi.fn(),
      recordProjectEvents,
      saveProject,
      runQueuedWorker,
      isTauri: true,
      ensureGuiDevSession: vi.fn(async () => ({
        listAcceptances: () => [],
      }) as never),
      recoveryDecisionPersistence: persistence,
    });

    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');
    await controller.recoverWorkerRun('run-1', 'retry', 'same request', undefined, 'request-1');

    expect(recordProjectEvents).toHaveBeenCalledTimes(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(runQueuedWorker).toHaveBeenCalledTimes(1);
    await expect(persistence.read()).resolves.toMatchObject({
      status: 'ok',
      journal: { entries: [expect.objectContaining({ requestIdentity: 'request-1', status: 'committed' })] },
    });
  });
});
