import { describe, expect, it } from 'vitest';
import {
  createWorkerRunQueue,
  runWorkerQueue,
} from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import { rehydrateWorkerRunsFromEvents } from './workerRunRehydration';

const graph: ProjectTaskGraph = {
  version: 1,
  id: 'graph-rehydrate-1',
  sessionId: 'session-rehydrate-1',
  architectureId: 'architecture-rehydrate-1',
  graphVersion: 1,
  tasks: [{
    version: 1,
    id: 'task-marker',
    architectureId: 'architecture-rehydrate-1',
    title: '生成 marker',
    description: '生成 marker 文件',
    moduleId: 'module-1',
    scope: ['docs/WORKER_E2E_OK.txt'],
    dependsOn: [],
    acceptanceCriteria: ['marker 存在'],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  }],
  approval: 'approved',
  approvedBy: 'user',
  approvedAt: '2026-09-15T00:00:00.000Z',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

describe('rehydrateWorkerRunsFromEvents', () => {
  it('rebuilds a partial Run and its failed Attempt when the ProjectFile projection is empty', async () => {
    const runId = 'run-rehydrate-1';
    const queue = createWorkerRunQueue({
      projectId: 'project-rehydrate-1',
      runId,
      orchestrationId: 'orch-rehydrate-1',
      taskGraph: graph,
      now: '2026-09-15T00:00:00.000Z',
    });
    const events = queue.drainEvents();

    await runWorkerQueue(queue, {
      allocator: {
        allocate: async () => ({
          worktreeId: 'worker-wt-1',
          path: 'D:/Temp/project-workers/worker-wt-1',
          branch: 'worker/worker-wt-1',
          baseRevision: '3be065ee082a5c4c10c1c3f0c11226154485b1f5',
        }),
      },
      executor: {
        execute: async () => ({ status: 'failed', error: 'acceptance failed' }),
      },
      onTransition: ({ events: transitionEvents }) => {
        events.push(...transitionEvents);
      },
    });

    const result = rehydrateWorkerRunsFromEvents({
      projectId: 'project-rehydrate-1',
      events,
      taskGraphs: [graph],
      existingRuns: [],
    });

    expect(result.issues).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      runId,
      status: 'partial',
      orchestrationId: 'orch-rehydrate-1',
    });
    expect(result.runs[0].tasks['task-marker']).toMatchObject({
      status: 'failed',
      attempt: 1,
      currentAttemptId: 'task-execution:run-rehydrate-1:task-marker:attempt-1',
      worktreeId: 'worker-wt-1',
      worktreePath: 'D:/Temp/project-workers/worker-wt-1',
      branch: 'worker/worker-wt-1',
      baseRevision: '3be065ee082a5c4c10c1c3f0c11226154485b1f5',
      worktreeStatus: 'created',
      error: 'acceptance failed',
    });
  });
});
