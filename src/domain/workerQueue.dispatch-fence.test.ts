import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';
import {
  createWorkerRunQueue,
  runWorkerQueue,
  type WorkerRunQueueState,
  type WorkerTaskLease,
} from './workerQueue';

function task(id: string): ProjectTask {
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

function graph(tasks: ProjectTask[]): ProjectTaskGraph {
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

describe('Worker queue dispatch fence', () => {
  it('checks parallel allocations against the last durably persisted run state', async () => {
    const queue = createWorkerRunQueue({
      projectId: 'project-1',
      runId: 'run-parallel-fence',
      taskGraph: graph([task('a'), task('b')]),
      now: '2026-09-01T00:00:01.000Z',
    });
    let durableState: WorkerRunQueueState = queue.snapshot();
    const allocated: string[] = [];
    const executed: string[] = [];

    const state = await runWorkerQueue(queue, {
      concurrency: 2,
      allocator: {
        allocate: async ({ task: queuedTask }) => {
          allocated.push(queuedTask.id);
          return {
            worktreeId: `worktree-${queuedTask.id}`,
            path: `C:/worktrees/${queuedTask.id}`,
            branch: `worker/${queuedTask.id}`,
            baseRevision: 'base-revision-1',
          };
        },
        release: async () => {},
      },
      executor: {
        execute: async (lease: WorkerTaskLease) => {
          executed.push(lease.task.id);
          return {
            status: 'succeeded',
            evidenceIds: [`evidence-${lease.task.id}`],
            acceptanceId: `acceptance-${lease.task.id}`,
          };
        },
      },
      assertBeforeExternalWork: (candidate) => {
        if (JSON.stringify(candidate) !== JSON.stringify(durableState)) {
          throw new Error('candidate/state drift');
        }
      },
      onTransition: ({ state: persistedState }) => {
        durableState = persistedState;
      },
    });

    expect(allocated).toEqual(['a', 'b']);
    expect(executed).toEqual(['a', 'b']);
    expect(state.tasks.a.status).toBe('succeeded');
    expect(state.tasks.b.status).toBe('succeeded');
    expect(durableState).toEqual(state);
  });
});
