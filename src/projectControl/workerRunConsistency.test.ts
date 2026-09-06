import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { EvidenceRecord } from '../dev/evidence';
import type { AcceptanceRecord } from '../dev/session';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { auditWorkerRunConsistency } from './workerRunConsistency';

const run: WorkerRunQueueState = {
  version: 1,
  projectId: 'project-1',
  runId: 'run-1',
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
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
      cleanupStatus: 'cleaned',
      cleanupReceiptId: 'cleanup-receipt-1',
      updatedAt: '2026-09-01T00:01:00.000Z',
    },
  },
};

function event(partial: Partial<DomainEvent> & Pick<DomainEvent, 'eventType' | 'aggregateType' | 'aggregateId' | 'payload'>): DomainEvent {
  return {
    eventId: partial.eventId ?? `event-${partial.sequence ?? 1}`,
    streamId: partial.streamId ?? 'project-1',
    sequence: partial.sequence ?? 1,
    aggregateType: partial.aggregateType,
    aggregateId: partial.aggregateId,
    aggregateVersion: partial.aggregateVersion ?? 1,
    eventType: partial.eventType,
    schemaVersion: 1,
    payload: partial.payload,
    actor: 'runtime',
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

const events: DomainEvent[] = [
  event({ eventId: 'run-queued', aggregateType: 'Run', aggregateId: 'run-1', eventType: 'RunQueued', payload: { runId: 'run-1' } }),
  event({ eventId: 'task-queued', sequence: 2, aggregateType: 'Task', aggregateId: 'task-1', eventType: 'TaskQueued', payload: { runId: 'run-1' } }),
  event({ eventId: 'run-started', sequence: 3, aggregateType: 'Run', aggregateId: 'run-1', aggregateVersion: 2, eventType: 'RunStarted', payload: { runId: 'run-1' } }),
  event({ eventId: 'task-started', sequence: 4, aggregateType: 'Task', aggregateId: 'task-1', aggregateVersion: 2, eventType: 'TaskStarted', payload: { runId: 'run-1' } }),
  event({
    eventId: 'task-succeeded',
    sequence: 5,
    aggregateType: 'Task',
    aggregateId: 'task-1',
    aggregateVersion: 3,
    eventType: 'TaskSucceeded',
    payload: { runId: 'run-1', evidenceIds: ['evidence-1'], acceptanceId: 'acceptance-1' },
  }),
  event({ eventId: 'task-cleaned', sequence: 6, aggregateType: 'Task', aggregateId: 'task-1', aggregateVersion: 4, eventType: 'TaskCleaned', payload: { runId: 'run-1', receiptId: 'cleanup-receipt-1' } }),
  event({ eventId: 'run-succeeded', sequence: 7, aggregateType: 'Run', aggregateId: 'run-1', aggregateVersion: 3, eventType: 'RunSucceeded', payload: { runId: 'run-1' } }),
];

const evidence1: EvidenceRecord = {
  id: 'evidence-1', orchestrationId: 'orch-1', stageId: 'task-1', kind: 'test', status: 'passed',
  summary: 'host test', capturedBy: 'host', runId: 'run-1', taskId: 'task-1',
  taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
  attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1), createdAt: '2026-09-01T00:01:00.000Z',
};
const acceptance1: AcceptanceRecord = {
  acceptanceId: 'acceptance-1', orchestrationId: 'orch-1', stageId: 'task-1', worktreePath: 'C:/worktree',
  passed: true, failedChecks: [], at: '2026-09-01T00:01:00.000Z', runId: 'run-1', taskId: 'task-1',
  taskExecutionId: evidence1.taskExecutionId!, attemptId: evidence1.attemptId!,
};

const trustedGraph: ProjectTaskGraph = {
  version: 1,
  id: 'graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 1,
  tasks: [{
    version: 1,
    id: 'task-1',
    architectureId: 'architecture-1',
    title: '实现任务',
    description: '完成实现',
    moduleId: 'module-1',
    scope: ['src'],
    dependsOn: [],
    acceptanceCriteria: ['通过'],
    category: 'implementation',
    status: 'approved',
    stageId: 'verify',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('worker run consistency audit', () => {
  it('accepts a ProjectFile worker registry that matches replayed facts', () => {
    expect(auditWorkerRunConsistency({ projectId: 'project-1', runs: [run], events, evidence: [evidence1], acceptances: [acceptance1] })).toMatchObject({
      ok: true,
      issues: [],
      projection: { runs: { 'run-1': { status: 'succeeded' } } },
    });
  });

  it('uses the task-owned acceptance stage override for audit scope', () => {
    const stageBoundRun: WorkerRunQueueState = {
      ...run,
      tasks: {
        'task-1': { ...run.tasks['task-1'], acceptanceStageId: 'verify' },
      },
    };
    const stageBoundEvidence = { ...evidence1, stageId: 'verify' };
    const stageBoundAcceptance = { ...acceptance1, stageId: 'verify' };

    expect(auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [stageBoundRun],
      events,
      evidence: [stageBoundEvidence],
      acceptances: [stageBoundAcceptance],
      taskGraphs: [trustedGraph],
    })).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects an explicit persisted stage when no trusted TaskGraph is supplied', () => {
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [{
        ...run,
        tasks: { 'task-1': { ...run.tasks['task-1'], acceptanceStageId: 'attacker-stage' } },
      }],
      events,
      evidence: [evidence1],
      acceptances: [acceptance1],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'acceptance-lineage-drift' }),
    ]));
  });

  it('uses trusted TaskGraph stage for legacy data and rejects explicit stage drift', () => {
    const legacyRun: WorkerRunQueueState = {
      ...run,
      tasks: { 'task-1': { ...run.tasks['task-1'], acceptanceStageId: undefined } },
    };
    const graphEvidence = { ...evidence1, stageId: 'verify' };
    const graphAcceptance = { ...acceptance1, stageId: 'verify' };
    const common = {
      projectId: 'project-1',
      events,
      evidence: [graphEvidence],
      acceptances: [graphAcceptance],
      taskGraphs: [trustedGraph],
    };
    expect(auditWorkerRunConsistency({ ...common, runs: [legacyRun] })).toMatchObject({ ok: true, issues: [] });
    const driftedRun = {
      ...legacyRun,
      tasks: { 'task-1': { ...legacyRun.tasks['task-1'], acceptanceStageId: 'attacker-stage' } },
    };
    expect(auditWorkerRunConsistency({ ...common, runs: [driftedRun] })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'acceptance-lineage-drift' })]),
    });
    expect(auditWorkerRunConsistency({
      ...common,
      runs: [run],
      taskGraphs: [{ ...trustedGraph, graphVersion: 2 }],
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'task-graph-version-drift' })]),
    });
  });

  it('reports persisted run and task status drift instead of choosing a side silently', () => {
    const drifted = {
      ...run,
      status: 'failed' as const,
      tasks: { 'task-1': { ...run.tasks['task-1'], status: 'failed' as const } },
    };
    const result = auditWorkerRunConsistency({ projectId: 'project-1', runs: [drifted], events });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['run-status-drift', 'task-status-drift']));
  });

  it('reports a persisted run with no durable Run fact', () => {
    const result = auditWorkerRunConsistency({ projectId: 'project-1', runs: [run], events: [] });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-run-event', runId: 'run-1' }),
    ]));
  });

  it('fails closed when the event stream cannot be replayed', () => {
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events: [
        events[0],
        { ...events[1], sequence: 4 },
      ],
      evidence: [],
      acceptances: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'invalid-event-stream' });
  });

  it('audits two executions of the same task definition independently', () => {
    const run2ExecutionId = createTaskExecutionId('run-2', 'task-1');
    const run2AttemptId = createAttemptId(run2ExecutionId, 1);
    const run2: WorkerRunQueueState = {
      ...run,
      runId: 'run-2',
      status: 'partial',
      tasks: {
        'task-1': {
          ...run.tasks['task-1'],
          status: 'failed',
          evidenceIds: ['evidence-2'],
          acceptanceId: undefined,
          cleanupStatus: undefined,
          cleanupReceiptId: undefined,
        },
      },
    };
    const run2Events: DomainEvent[] = [
      event({ eventId: 'run-2-partial', sequence: 8, aggregateType: 'Run', aggregateId: 'run-2', eventType: 'RunPartial', payload: { runId: 'run-2' } }),
      event({
        eventId: 'run-2-task-started',
        sequence: 9,
        aggregateType: 'TaskExecution',
        aggregateId: run2ExecutionId,
        aggregateVersion: 1,
        eventType: 'TaskStarted',
        payload: {
          runId: 'run-2',
          taskId: 'task-1',
          taskExecutionId: run2ExecutionId,
          attempt: 1,
          attemptId: run2AttemptId,
        },
      }),
      event({
        eventId: 'run-2-task-failed',
        sequence: 10,
        aggregateType: 'TaskExecution',
        aggregateId: run2ExecutionId,
        aggregateVersion: 2,
        eventType: 'TaskFailed',
        payload: {
          runId: 'run-2',
          taskId: 'task-1',
          taskExecutionId: run2ExecutionId,
          attempt: 1,
          attemptId: run2AttemptId,
          evidenceIds: ['evidence-2'],
        },
      }),
    ];

    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run, run2],
      events: [...events, ...run2Events],
      evidence: [evidence1, {
        ...evidence1,
        id: 'evidence-2',
        runId: 'run-2',
        taskExecutionId: run2ExecutionId,
        attemptId: run2AttemptId,
      }],
      acceptances: [acceptance1],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.projection.taskExecutions[createTaskExecutionId('run-1', 'task-1')]).toMatchObject({
      status: 'succeeded',
    });
    expect(result.projection.taskExecutions[run2ExecutionId]).toMatchObject({
      status: 'failed',
      currentAttemptId: run2AttemptId,
    });
  });

  it('reports an unregistered task execution even when its task definition exists in another Run', () => {
    const orphanExecutionId = createTaskExecutionId('run-orphan', 'task-1');
    const orphanAttemptId = createAttemptId(orphanExecutionId, 1);
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events: [
        ...events,
        event({
          eventId: 'orphan-run-started',
          sequence: 8,
          aggregateType: 'Run',
          aggregateId: 'run-orphan',
          eventType: 'RunStarted',
          payload: { runId: 'run-orphan' },
        }),
        event({
          eventId: 'orphan-task-started',
          sequence: 9,
          aggregateType: 'TaskExecution',
          aggregateId: orphanExecutionId,
          aggregateVersion: 1,
          eventType: 'TaskStarted',
          payload: {
            runId: 'run-orphan',
            taskId: 'task-1',
            taskExecutionId: orphanExecutionId,
            attempt: 1,
            attemptId: orphanAttemptId,
          },
        }),
      ],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'orphaned-task-event', runId: 'run-orphan', taskId: 'task-1' }),
    ]));
  });

  it('reports evidence that is bound to a future attempt instead of the task current attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const evidence: EvidenceRecord = {
      id: 'evidence-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      kind: 'test',
      status: 'passed',
      summary: 'future attempt',
      capturedBy: 'host',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 2),
      worktreePath: 'C:/project-workers/run-1/task-1',
      createdAt: '2026-09-01T00:01:00.000Z',
    };
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events,
      evidence: [evidence],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'evidence-lineage-drift', runId: 'run-1', taskId: 'task-1' }),
    ]));
  });

  it('reports partial provenance even for a legacy task snapshot', () => {
    const evidence: EvidenceRecord = {
      id: 'evidence-1',
      kind: 'test',
      status: 'passed',
      summary: 'legacy partial',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      capturedBy: 'host',
      createdAt: '2026-09-01T00:01:00.000Z',
      runId: 'other-run',
      taskId: 'task-1',
    };
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events,
      evidence: [evidence],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'evidence-lineage-drift', runId: 'run-1', taskId: 'task-1' }),
    ]));
  });

  it('reports acceptance that is bound to a future attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const acceptance: AcceptanceRecord = {
      acceptanceId: 'acceptance-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: 'C:/project-workers/run-1/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:01:00.000Z',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: createAttemptId(taskExecutionId, 2),
    };
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events,
      acceptances: [acceptance],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'acceptance-lineage-drift', runId: 'run-1', taskId: 'task-1' }),
    ]));
  });

  it('reports task references that still point at an older attempt', () => {
    const taskExecutionId = createTaskExecutionId('run-current-two', 'task-1');
    const attemptOneId = createAttemptId(taskExecutionId, 1);
    const attemptTwoId = createAttemptId(taskExecutionId, 2);
    const runCurrentTwo: WorkerRunQueueState = {
      ...run,
      runId: 'run-current-two',
      status: 'succeeded',
      tasks: {
        'task-1': {
          ...run.tasks['task-1'],
          taskExecutionId,
          status: 'succeeded',
          attempt: 2,
          currentAttemptId: attemptTwoId,
          evidenceIds: ['evidence-old-attempt'],
          acceptanceId: 'acceptance-old-attempt',
          cleanupStatus: undefined,
          cleanupReceiptId: undefined,
        },
      },
    };
    const currentTwoEvents: DomainEvent[] = [
      event({ eventId: 'current-two-run', aggregateType: 'Run', aggregateId: 'run-current-two', eventType: 'RunQueued', payload: { runId: 'run-current-two' } }),
      event({
        eventId: 'current-two-start-one',
        sequence: 2,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        eventType: 'TaskStarted',
        payload: { runId: 'run-current-two', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId: attemptOneId },
      }),
      event({
        eventId: 'current-two-fail-one',
        sequence: 3,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 2,
        eventType: 'TaskFailed',
        payload: { runId: 'run-current-two', taskId: 'task-1', taskExecutionId, attempt: 1, attemptId: attemptOneId },
      }),
      event({
        eventId: 'current-two-queue-two',
        sequence: 4,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 3,
        eventType: 'TaskQueued',
        payload: { runId: 'run-current-two', taskId: 'task-1', taskExecutionId, nextAttempt: 2 },
      }),
      event({
        eventId: 'current-two-start-two',
        sequence: 5,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 4,
        eventType: 'TaskStarted',
        payload: { runId: 'run-current-two', taskId: 'task-1', taskExecutionId, attempt: 2, attemptId: attemptTwoId },
      }),
      event({
        eventId: 'current-two-succeed-two',
        sequence: 6,
        aggregateType: 'TaskExecution',
        aggregateId: taskExecutionId,
        aggregateVersion: 5,
        eventType: 'TaskSucceeded',
        payload: {
          runId: 'run-current-two',
          taskId: 'task-1',
          taskExecutionId,
          attempt: 2,
          attemptId: attemptTwoId,
          evidenceIds: ['evidence-old-attempt'],
          acceptanceId: 'acceptance-old-attempt',
        },
      }),
      event({
        eventId: 'current-two-run-success',
        sequence: 7,
        aggregateType: 'Run',
        aggregateId: 'run-current-two',
        aggregateVersion: 2,
        eventType: 'RunSucceeded',
        payload: { runId: 'run-current-two' },
      }),
    ];
    const evidence: EvidenceRecord = {
      id: 'evidence-old-attempt',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      kind: 'test',
      status: 'passed',
      summary: 'old attempt',
      capturedBy: 'host',
      runId: 'run-current-two',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: attemptOneId,
      worktreePath: 'C:/project-workers/run-current-two/task-1',
      createdAt: '2026-09-01T00:01:00.000Z',
    };
    const acceptance: AcceptanceRecord = {
      acceptanceId: 'acceptance-old-attempt',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      worktreePath: 'C:/project-workers/run-current-two/task-1',
      passed: true,
      failedChecks: [],
      at: '2026-09-01T00:01:00.000Z',
      runId: 'run-current-two',
      taskId: 'task-1',
      taskExecutionId,
      attemptId: attemptOneId,
    };
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [runCurrentTwo],
      events: currentTwoEvents,
      evidence: [evidence],
      acceptances: [acceptance],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'evidence-lineage-drift', runId: 'run-current-two', taskId: 'task-1' }),
      expect.objectContaining({ code: 'acceptance-lineage-drift', runId: 'run-current-two', taskId: 'task-1' }),
    ]));
  });

  it('reports an unscoped side effect instead of skipping it', () => {
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [run],
      events,
      sideEffects: [{
        idempotencyKey: 'unscoped-effect',
        kind: 'worker-execution',
        target: 'worktree-1',
        inputHash: 'input-1',
        runId: 'run-1',
        status: 'unknown',
        recovery: 'needs-user',
      }],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'side-effect-lineage-drift' }),
    ]));
  });

  it('accepts the canonical Worker side-effect hash with path and branch provenance', () => {
    const taskExecutionId = createTaskExecutionId('run-1', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const running: WorkerRunQueueState = {
      ...run,
      status: 'running',
      tasks: {
        'task-1': {
          ...run.tasks['task-1'],
          status: 'running',
          taskDefinitionVersion: 1,
          taskExecutionId,
          currentAttemptId: attemptId,
          worktreeId: 'worktree-1',
          worktreePath: 'C:/worktrees/task-1',
          branch: 'worker/task-1',
          baseRevision: 'base-1',
          evidenceIds: [],
          acceptanceId: undefined,
          cleanupStatus: undefined,
          cleanupReceiptId: undefined,
        },
      },
    };
    const result = auditWorkerRunConsistency({
      projectId: 'project-1',
      runs: [running],
      events: [],
      evidence: [],
      acceptances: [],
      sideEffects: [{
        idempotencyKey: `worker-execution:${attemptId}:attempt-1`,
        kind: 'worker-execution',
        target: 'worktree-1',
        inputHash: JSON.stringify([
          'run-1',
          'task-1',
          1,
          1,
          'base-1',
          'C:/worktrees/task-1',
          'worker/task-1',
        ]),
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId,
        attemptId,
        status: 'started',
        recovery: 'retry',
      }],
    });

    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'side-effect-lineage-drift' }),
    ]));
  });
});
