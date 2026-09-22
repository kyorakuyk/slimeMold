import { describe, expect, it } from 'vitest';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import {
  buildWorkerRecoveryFactsV1,
  canonicalizeWorkerRecoveryFactsV1,
  fingerprintWorkerRecoveryFactsV1,
} from './workerRecoveryFactsFingerprint';
import { validateFactsDto } from './workerRecoveryFactsDtoValidation';

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
    inputHash: '["run-1","task-1",1,1,"0123456789abcdef0123456789abcdef01234567","C:/worktree","worker/task-1"]',
    runId: 'run-1',
    taskId: 'task-1',
    taskExecutionId: 'task-execution:run-1:task-1',
    attemptId: 'task-execution:run-1:task-1:attempt-1',
    status: 'unknown',
    recovery: 'needs-user',
    unknownReason: 'worker interrupted',
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
        baseRevision: '0123456789abcdef0123456789abcdef01234567',
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
      inputHash: '["run-1","task-2",1,1,"0123456789abcdef0123456789abcdef01234567","C:/worktree-2","worker/task-2"]',
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
      baseRevision: '0123456789abcdef0123456789abcdef01234567',
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
        inputHash: '["run-1","task-1",1,2,"0123456789abcdef0123456789abcdef01234567","C:/worktree","worker/task-1"]',
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

  it.each(['running', 'waiting-feedback', 'succeeded'] as const)(
    'rejects direct DTO %s task with attempt zero and no current lineage',
    (status) => {
      const facts = buildWorkerRecoveryFactsV1(input());
      const task = facts.run.tasks[0];
      const malformed = {
        ...facts,
        run: {
          ...facts.run,
          tasks: [{
            ...task,
            status,
            attempt: 0,
            taskExecutionId: undefined,
            currentAttemptId: undefined,
            ...(status === 'waiting-feedback' ? { feedbackId: 'feedback-1' } : {}),
          }],
        },
        failedTaskIds: status === 'running' ? [task.taskId] : [],
        recoverableEffects: [],
      };
      expect(() => canonicalizeWorkerRecoveryFactsV1(malformed)).toThrow();
    },
  );

  it('rejects direct DTO failedTaskIds that do not equal failed and running tasks', () => {
    const facts = buildWorkerRecoveryFactsV1(input());
    expect(() => canonicalizeWorkerRecoveryFactsV1({
      ...facts,
      failedTaskIds: ['ghost-task'],
    })).toThrow();
  });

  it('preserves direct DTO validation diagnostic field names', () => {
    const facts = buildWorkerRecoveryFactsV1(input());
    expect(() => validateFactsDto({
      ...facts,
      run: { ...facts.run, taskGraphVersion: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow('facts.run taskGraphVersion');
  });

  it('uses the shared object guard for array-shaped source receipts', () => {
    const arrayReceipt = Object.assign([], { outcome: 'succeeded' }) as never;
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ status: 'receipt', recovery: 'skip', receipt: arrayReceipt })],
    }))).toThrow('receipt 必须是对象');
  });

  it('rejects missing lineage, invalid receipts, duplicate terminal ids, paths, and graph references', () => {
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
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          currentAttemptId: undefined,
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ status: 'receipt', recovery: 'skip', receipt: { receiptId: 'receipt-1', outcome: 'other' } as never })],
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      sideEffects: [effect({ idempotencyKey: 'effect-1' }), effect({ idempotencyKey: 'effect-1' })],
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          worktreePath: 'C:/worktree/../other',
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      taskGraph: graph([{ ...task('task-1'), dependsOn: ['task-1', 'task-1'] }]),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          status: 'queued',
          pendingAttempt: 3,
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          status: 'failed',
          cleanupStatus: 'cleaned',
          worktreeStatus: 'cleaned',
          cleanupReceiptId: 'receipt-1',
        },
      }),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      taskGraph: graph([task('task-1'), task('task-2')]),
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      taskGraph: { ...graph([task('task-1')]), approvedAt: 'not-a-timestamp' },
    }))).toThrow();
    expect(() => buildWorkerRecoveryFactsV1(input({
      run: run({
        'task-1': {
          ...input().run.tasks['task-1'],
          branch: 'worker/foo.lock',
        },
      }),
    }))).toThrow();
    const facts = buildWorkerRecoveryFactsV1(input());
    const reorderedFacts = {
      ...facts,
      run: { ...facts.run, tasks: [...facts.run.tasks].reverse() },
      taskGraph: { ...facts.taskGraph, tasks: [...facts.taskGraph.tasks].reverse() },
      failedTaskIds: [...facts.failedTaskIds].reverse(),
      recoverableEffects: [...facts.recoverableEffects].reverse(),
    };
    expect(canonicalizeWorkerRecoveryFactsV1(reorderedFacts)).toBe(canonicalizeWorkerRecoveryFactsV1(facts));
    expect(() => canonicalizeWorkerRecoveryFactsV1({
      ...facts,
      run: { ...facts.run, status: 'forged' as never },
    })).toThrow();
    expect(() => canonicalizeWorkerRecoveryFactsV1({
      ...facts,
      run: {
        ...facts.run,
        tasks: [{ ...facts.run.tasks[0], branch: 'worker/.hidden', baseRevision: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }],
      },
    })).toThrow();
  });
});
