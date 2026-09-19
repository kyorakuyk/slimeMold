import { describe, expect, it } from 'vitest';
import type { Orchestration } from '../types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { projectWorkerRunOntoOrchestration, projectWorkerRunsOntoOrchestrations, selectLatestWorkerRun } from './workerRunOrchestrationProjection';

function orchestration(): Orchestration {
  return {
    id: 'orch-1',
    goal: '完成项目任务',
    status: 'ready',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    draft: {
      stages: [
        {
          id: 'construction',
          label: '施工',
          role: 'constructor',
          goal: '完成实现',
          wfRef: { kind: 'existing', wfId: 'wf-1' },
          taskIds: ['task-1'],
        },
        {
          id: 'acceptance',
          label: '验收',
          role: 'ops',
          goal: '验证结果',
          wfRef: { kind: 'existing', wfId: 'wf-2' },
          taskIds: ['task-1'],
        },
      ],
      edges: [{ from: 'construction', to: 'acceptance', artifactKind: 'project' }],
    },
    stageLogs: [
      { stageId: 'construction', status: 'pending' },
      { stageId: 'acceptance', status: 'pending' },
    ],
    runIds: [],
  };
}

function run(
  status: WorkerRunQueueState['status'],
  taskStatus: WorkerRunQueueState['tasks'][string]['status'],
  error?: string,
): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orch-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        status: taskStatus,
        attempt: status === 'queued' ? 0 : 1,
        evidenceIds: taskStatus === 'succeeded' ? ['ev-1'] : [],
        acceptanceId: taskStatus === 'succeeded' ? 'acceptance-1' : undefined,
        error,
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
    },
  };
}

describe('Worker Run → Orchestration projection', () => {
  it('links a queued run without claiming it has started', () => {
    const projected = projectWorkerRunOntoOrchestration(orchestration(), run('queued', 'queued'));

    expect(projected.status).toBe('ready');
    expect(projected.runIds).toEqual(['run-1']);
    expect(projected.stageLogs.every((log) => log.status === 'pending')).toBe(true);
  });

  it('projects a succeeded Worker task as a completed orchestration', () => {
    const projected = projectWorkerRunOntoOrchestration(orchestration(), run('succeeded', 'succeeded'));

    expect(projected.status).toBe('done');
    expect(projected.runIds).toEqual(['run-1']);
    expect(projected.stageLogs.every((log) => log.status === 'success')).toBe(true);
    expect(projected.stageLogs.every((log) => log.runId === 'run-1')).toBe(true);
  });

  it('does not project an invalid succeeded run as done', () => {
    const valid = run('succeeded', 'succeeded');
    const invalid = {
      ...valid,
      tasks: {
        'task-1': { ...valid.tasks['task-1'], acceptanceId: undefined },
      },
    };
    const projected = projectWorkerRunOntoOrchestration(orchestration(), invalid);

    expect(projected.status).not.toBe('done');
    expect(projected.stageLogs.every((log) => log.status !== 'success')).toBe(true);
  });


  it('projects a failed Worker task as a failed orchestration with the real error', () => {
    const projected = projectWorkerRunOntoOrchestration(
      orchestration(),
      run('partial', 'failed', '宿主验收失败：tests'),
    );

    expect(projected.status).toBe('failed');
    expect(projected.runIds).toEqual(['run-1']);
    expect(projected.stageLogs.every((log) => log.status === 'failed')).toBe(true);
    expect(projected.stageLogs.every((log) => log.error === '宿主验收失败：tests')).toBe(true);
  });

  it('keeps stage logs isolated for multiple runs of one orchestration', () => {
    const first = run('succeeded', 'succeeded');
    const second = {
      ...run('running', 'running'),
      runId: 'run-2',
      updatedAt: '2026-09-01T00:02:00.000Z',
      tasks: {
        'task-1': { ...run('running', 'running').tasks['task-1'], taskId: 'task-1', status: 'running' as const },
      },
    };
    const [projected] = projectWorkerRunsOntoOrchestrations([orchestration()], [second, first]);

    expect(projected.activeRunId).toBe('run-2');
    expect(projected.stageLogs.every((log) => log.runId === 'run-2')).toBe(true);
    expect(projected.stageLogsByRun?.['run-1']?.every((log) => log.runId === 'run-1')).toBe(true);
    expect(projected.stageLogsByRun?.['run-2']?.every((log) => log.runId === 'run-2')).toBe(true);
    expect(selectLatestWorkerRun([first, second], 'orch-1')).toBe(second);
  });
});
