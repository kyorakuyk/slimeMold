import { describe, expect, it } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import {
  assertWorkerRecoveryDecisionPrecondition,
  type WorkerRecoveryDecisionPrecondition,
} from './workerRecoveryDecisionPrecondition';

const run = (runId: string, status: WorkerRunQueueState['status'] = 'running') => ({
  runId,
  projectId: 'project-1',
  status,
  tasks: {},
  updatedAt: '2026-09-21T00:00:00.000Z',
} as unknown as WorkerRunQueueState);

const graph = (version: number): ProjectTaskGraph => ({
  id: 'graph-1',
  graphVersion: version,
  approval: 'approved',
  tasks: [],
} as unknown as ProjectTaskGraph);

function input(overrides: Partial<WorkerRecoveryDecisionPrecondition> = {}): WorkerRecoveryDecisionPrecondition {
  const capturedRun = run('run-1');
  const capturedGraph = graph(1);
  return {
    projectId: 'project-1',
    projectPath: 'C:/project',
    runId: 'run-1',
    capturedRun,
    capturedTaskGraph: capturedGraph,
    current: {
      projectId: 'project-1',
      projectPath: 'C:/project',
      workerRuns: [capturedRun],
      taskGraphs: [capturedGraph],
    },
    ...overrides,
  };
}

describe('assertWorkerRecoveryDecisionPrecondition', () => {
  it('accepts the captured run and task graph when same-project facts are unchanged', () => {
    expect(() => assertWorkerRecoveryDecisionPrecondition(input())).not.toThrow();
  });

  it('rejects a same-project run mutation before applying the decision', () => {
    expect(() => assertWorkerRecoveryDecisionPrecondition(input({
      current: {
        projectId: 'project-1',
        projectPath: 'C:/project',
        workerRuns: [run('run-1', 'failed')],
        taskGraphs: [graph(1)],
      },
    }))).toThrow('Worker Run 在 recovery 决定期间发生变化：run-1');
  });

  it('rejects a same-project task graph revision change', () => {
    expect(() => assertWorkerRecoveryDecisionPrecondition(input({
      current: {
        projectId: 'project-1',
        projectPath: 'C:/project',
        workerRuns: [run('run-1')],
        taskGraphs: [graph(2)],
      },
    }))).toThrow('TaskGraph 在 recovery 决定期间发生变化：run-1');
  });

  it('rejects project identity drift before comparing recovery facts', () => {
    expect(() => assertWorkerRecoveryDecisionPrecondition(input({
      current: {
        projectId: 'project-2',
        projectPath: 'C:/project-2',
        workerRuns: [run('run-1')],
        taskGraphs: [graph(1)],
      },
    }))).toThrow('项目在 recovery 决定期间发生切换');
  });
});
