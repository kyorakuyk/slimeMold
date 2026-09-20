import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunRecovery } from './workerRunRuntime';
import { projectWorkerRecoveryActions } from './workerRecoveryCapabilityProjection';

function run(overrides: Partial<WorkerRunQueueState> = {}): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'partial',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: 'failed',
        attempt: 1,
        evidenceIds: [],
        error: 'failed',
        updatedAt: '2026-09-21T00:01:00.000Z',
      },
    },
    ...overrides,
  };
}

function graph(overrides: Partial<ProjectTaskGraph> = {}): ProjectTaskGraph {
  return {
    id: 'graph-1',
    graphVersion: 1,
    approval: 'approved',
    tasks: [{
      id: 'task-1',
      version: 1,
      architectureId: 'architecture-1',
      moduleId: 'module-1',
      category: 'logic',
      status: 'approved',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      title: 'Task 1',
      description: 'Task 1',
      dependsOn: [],
      scope: [],
      acceptanceCriteria: [],
    }],
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  } as ProjectTaskGraph;
}

function recovery(reason: WorkerRunRecovery['reason'] = 'failed-tasks'): WorkerRunRecovery {
  return { runId: 'run-1', projectId: 'project-1', reason, message: 'recover' };
}

describe('projectWorkerRecoveryActions', () => {
  it('projects retry and skip from the canonical failed-task recovery plan', () => {
    expect(projectWorkerRecoveryActions({
      run: run(),
      recovery: recovery(),
      taskGraph: graph(),
      sideEffects: [],
    })).toEqual(['retry', 'skip']);
  });

  it('fails closed when the task graph is missing or stale', () => {
    expect(projectWorkerRecoveryActions({ run: run(), recovery: recovery(), taskGraph: null, sideEffects: [] })).toEqual([]);
    expect(projectWorkerRecoveryActions({
      run: run(),
      recovery: recovery(),
      taskGraph: graph({ graphVersion: 2 }),
      sideEffects: [],
    })).toEqual([]);
  });

  it('does not synthesize actions for audit or graph recovery reasons', () => {
    expect(projectWorkerRecoveryActions({
      run: run(),
      recovery: recovery('event-stream-invalid'),
      taskGraph: graph(),
      sideEffects: [],
    })).toEqual([]);
  });

  it('fails closed when a side-effect fact cannot form a valid current plan', () => {
    const malformed: SideEffectRecord = {
      idempotencyKey: 'effect-1',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'malformed',
      runId: 'run-1',
      taskId: 'task-1',
      status: 'unknown',
      recovery: 'needs-user',
    };
    expect(projectWorkerRecoveryActions({
      run: run(),
      recovery: recovery('unfinished-worker-lease'),
      taskGraph: graph(),
      sideEffects: [malformed],
    })).toEqual([]);
  });
});
