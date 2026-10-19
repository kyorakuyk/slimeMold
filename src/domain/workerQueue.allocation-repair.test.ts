import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';
import { replayDomainEvents } from './contracts';
import { createAttemptId, createTaskExecutionId } from './execution';
import { createWorkerRunQueue } from './workerQueue';

function makeTask(id: string): ProjectTask {
  return {
    version: 1,
    id,
    architectureId: 'architecture-1',
    title: `任务 ${id}`,
    description: `执行 ${id}`,
    moduleId: `module-${id}`,
    scope: [`src/${id}`],
    dependsOn: [],
    acceptanceCriteria: [`${id} 通过测试`],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function makeGraph(tasks: ProjectTask[]): ProjectTaskGraph {
  return {
    version: 1,
    id: 'task-graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 3,
    tasks,
    approval: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('Worker allocation repair', () => {
  it('keeps TaskStarted status and replayed assignment aligned with repair state', () => {
    const runId = 'run-allocation-registration-pending';
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId,
      taskGraph: makeGraph([makeTask('a')]),
      now: '2026-09-01T00:01:00.000Z',
    });
    const initialEvents = queue.drainEvents();
    const taskExecutionId = createTaskExecutionId(runId, 'a');
    const attemptId = createAttemptId(taskExecutionId, 1);

    queue.recordAllocationRepairRequired({
      taskId: 'a',
      attempt: 1,
      taskExecutionId,
      attemptId,
      assignment: {
        worktreeId: 'worktree-a',
        path: 'C:/worktrees/a',
        branch: 'worker/a',
        baseRevision: 'base-revision-1',
      },
      worktreeStatus: 'registration-pending',
      reason: 'git worktree add outcome is unknown',
    }, '2026-09-01T00:01:01.000Z');

    const repairEvents = queue.drainEvents();
    const started = repairEvents.find((event) => event.eventType === 'TaskStarted');
    const failed = repairEvents.find((event) => event.eventType === 'TaskFailed');
    expect(started?.payload).toMatchObject({ worktreeStatus: 'registration-pending' });
    expect(failed?.payload).toMatchObject({ worktreeStatus: 'registration-pending' });
    expect(queue.snapshot().tasks.a).toMatchObject({
      status: 'failed',
      worktreeStatus: 'registration-pending',
    });

    const replayed = replayDomainEvents([...initialEvents, ...repairEvents]);
    expect(replayed.attempts[attemptId]).toMatchObject({
      status: 'failed',
      worktreeId: 'worktree-a',
      worktreePath: 'C:/worktrees/a',
      branch: 'worker/a',
      baseRevision: 'base-revision-1',
    });
  });
});
