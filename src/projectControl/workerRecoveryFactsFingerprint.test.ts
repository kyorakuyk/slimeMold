import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import {
  buildWorkerRecoveryFactsV1,
  canonicalizeWorkerRecoveryFactsV1,
  fingerprintWorkerRecoveryFactsV1,
} from './workerRecoveryFactsFingerprint';

function task(id: string) {
  return {
    version: 1 as const,
    id,
    architectureId: 'architecture-1',
    moduleId: id,
    title: id,
    description: id,
    scope: [`src/${id}.ts`],
    dependsOn: [],
    acceptanceCriteria: ['passes'],
    category: 'logic' as const,
    status: 'approved' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function run(taskEntries: WorkerRunQueueState['tasks']): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'partial',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:01:00.000Z',
    tasks: taskEntries,
  };
}

function graph(tasks: ProjectTaskGraph['tasks']): ProjectTaskGraph {
  return {
    version: 1,
    id: 'graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 1,
    tasks,
    approval: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:01:00.000Z',
  };
}

function effect(overrides: Partial<SideEffectRecord> = {}): SideEffectRecord {
  return {
    idempotencyKey: 'effect-1',
    kind: 'worker-execution',
    target: 'worktree-1',
    inputHash: '["run-1","task-1",1,1,"base","C:/worktree","worker/task-1"]',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId: 'task-execution:run-1:task-1',
    attemptId: 'task-execution:run-1:task-1:attempt-1',
    status: 'unknown',
    recovery: 'needs-user',
    ...overrides,
  };
}

function input(overrides: {
  run?: WorkerRunQueueState;
  taskGraph?: ProjectTaskGraph;
  sideEffects?: readonly SideEffectRecord[];
} = {}) {
  return {
    projectId: 'project-1',
    run: overrides.run ?? run({
      'task-1': {
        taskId: 'task-1',
        status: 'failed',
        attempt: 1,
        taskExecutionId: 'task-execution:run-1:task-1',
        currentAttemptId: 'task-execution:run-1:task-1:attempt-1',
        worktreeId: 'worktree-1',
        worktreePath: 'C:/worktree',
        branch: 'worker/task-1',
        baseRevision: 'base',
        evidenceIds: ['evidence-1'],
        updatedAt: '2026-09-20T00:01:00.000Z',
      },
    }),
    taskGraph: overrides.taskGraph ?? graph([task('task-1')]),
    sideEffects: overrides.sideEffects ?? [effect()],
  };
}

describe('worker recovery facts fingerprint v1', () => {
  it('is stable across object, task, and effect insertion order', async () => {
    const effectTwo = effect({
      idempotencyKey: 'effect-2',
      target: 'worktree-2',
      taskId: 'task-2',
      taskExecutionId: 'task-execution:run-1:task-2',
      attemptId: 'task-execution:run-1:task-2:attempt-1',
      inputHash: '["run-1","task-2",1,1,"base","C:/worktree-2","worker/task-2"]',
    });
    const taskTwo = {
      taskId: 'task-2',
      status: 'running' as const,
      attempt: 1,
      taskExecutionId: 'task-execution:run-1:task-2',
      currentAttemptId: 'task-execution:run-1:task-2:attempt-1',
      worktreeId: 'worktree-2',
      worktreePath: 'C:/worktree-2',
      branch: 'worker/task-2',
      baseRevision: 'base',
      evidenceIds: ['evidence-2'],
      updatedAt: '2026-09-20T00:01:00.000Z',
    };
    const first = input({
      run: run({
        'task-1': { ...input().run.tasks['task-1'] },
        'task-2': taskTwo,
      }),
      taskGraph: graph([task('task-1'), task('task-2')]),
      sideEffects: [effect(), effectTwo],
    });
    const second = input({
      run: run({
        'task-2': { ...taskTwo },
        'task-1': { ...first.run.tasks['task-1'] },
      }),
      taskGraph: graph([task('task-2'), task('task-1')]),
      sideEffects: [effectTwo, effect()],
    });
    second.run.createdAt = '2026-09-21T00:00:00.000Z';
    second.run.updatedAt = '2026-09-21T00:02:00.000Z';
    second.taskGraph.createdAt = '2026-09-21T00:00:01.000Z';
    second.taskGraph.updatedAt = '2026-09-21T00:02:00.000Z';

    const firstFingerprint = await fingerprintWorkerRecoveryFactsV1(first);
    const secondFingerprint = await fingerprintWorkerRecoveryFactsV1(second);
    expect(firstFingerprint).toBe(secondFingerprint);
    expect(canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(first)))
      .toBe(canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(second)));
  });

  it('changes when current attempt identity or recoverable effect identity changes', async () => {
    const baseline = await fingerprintWorkerRecoveryFactsV1(input());
    const changedAttempt = await fingerprintWorkerRecoveryFactsV1({
      ...input(),
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          attempt: 2,
          currentAttemptId: 'task-execution:run-1:task-1:attempt-2',
        },
      }),
      sideEffects: [effect({
        attemptId: 'task-execution:run-1:task-1:attempt-2',
        inputHash: '["run-1","task-1",1,2,"base","C:/worktree","worker/task-1"]',
      })],
    });
    const changedEffect = await fingerprintWorkerRecoveryFactsV1({
      ...input(),
      sideEffects: [effect({ unknownReason: 'changed-reason' })],
    });
    expect(changedAttempt).not.toBe(baseline);
    expect(changedEffect).not.toBe(baseline);
  });

  it('rejects cross-task lineage, legacy ids, and malformed assignment provenance', () => {
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ taskId: 'ghost-task' })],
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ taskExecutionId: 'legacy-execution' })],
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ inputHash: 'not-json' })],
    }))).toThrow();
  });

  it('rejects invalid states, unsafe numbers, and duplicate references', () => {
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          attempt: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          status: 'not-a-status' as never,
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          evidenceIds: ['evidence-1', 'evidence-1'],
        },
      }),
    }))).toThrow();
  });
});
