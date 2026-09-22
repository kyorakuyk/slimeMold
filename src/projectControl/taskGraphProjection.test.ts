import { describe, expect, it } from 'vitest';
import type { DomainProjection } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectIssue, ProjectTaskGraph } from './types';
import {
  buildTaskGraphProjection,
  buildTaskGraphProjectionFromWorkerRun,
  materializeTaskIssues,
  taskIssueId,
} from './taskGraphProjection';

const graph: ProjectTaskGraph = {
  version: 1,
  id: 'task-graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 3,
  approval: 'approved',
  createdAt: '2026-09-12T01:00:00.000Z',
  updatedAt: '2026-09-12T01:01:00.000Z',
  approvedBy: 'user',
  approvedAt: '2026-09-12T01:01:00.000Z',
  tasks: [
    {
      version: 1,
      id: 'task-plan',
      issueId: 'issue-plan',
      architectureId: 'architecture-1',
      title: '生成计划',
      description: '把目标拆成可执行任务',
      moduleId: 'control-plane',
      scope: ['src/projectControl/**'],
      dependsOn: [],
      acceptanceCriteria: ['任务图可审查'],
      category: 'planning',
      status: 'done',
      workflowId: 'workflow-1',
      stageId: 'plan',
      createdAt: '2026-09-12T01:00:00.000Z',
      updatedAt: '2026-09-12T01:02:00.000Z',
    },
    {
      version: 1,
      id: 'task-build',
      issueId: 'issue-build',
      architectureId: 'architecture-1',
      title: '执行实现',
      description: '执行 Worker 任务',
      moduleId: 'control-plane',
      scope: ['src/projectControl/**'],
      dependsOn: ['task-plan'],
      acceptanceCriteria: ['Evidence 可读回'],
      category: 'implementation',
      status: 'in_progress',
      workflowId: 'workflow-1',
      stageId: 'build',
      createdAt: '2026-09-12T01:00:00.000Z',
      updatedAt: '2026-09-12T01:03:00.000Z',
    },
  ],
};

const issues: ProjectIssue[] = [
  {
    version: 1,
    id: 'issue-plan',
    projectId: 'project-1',
    type: 'feature',
    status: 'done',
    priority: 'normal',
    title: '生成计划',
    description: '把目标拆成可执行任务',
    tags: [],
    relatedArtifactIds: [],
    relatedTaskIds: ['task-plan'],
    createdAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T01:02:00.000Z',
  },
  {
    version: 1,
    id: 'issue-build',
    projectId: 'project-1',
    type: 'feature',
    status: 'in_progress',
    priority: 'normal',
    title: '执行实现',
    description: '执行 Worker 任务',
    tags: [],
    relatedArtifactIds: [],
    relatedTaskIds: ['task-build'],
    createdAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T01:03:00.000Z',
  },
];

const execution: DomainProjection = {
  lastSequence: 4,
  runs: { 'run-1': { status: 'running' } },
  tasks: {},
  taskExecutions: {
    'task-execution:run-1:task-build': {
      taskExecutionId: 'task-execution:run-1:task-build',
      taskId: 'task-build',
      runId: 'run-1',
      status: 'running',
      attemptIds: ['task-execution:run-1:task-build:attempt-1'],
      currentAttemptId: 'task-execution:run-1:task-build:attempt-1',
      evidenceIds: ['evidence-build'],
      acceptanceId: 'acceptance-build',
    },
  },
  attempts: {
    'task-execution:run-1:task-build:attempt-1': {
      attemptId: 'task-execution:run-1:task-build:attempt-1',
      taskExecutionId: 'task-execution:run-1:task-build',
      taskId: 'task-build',
      runId: 'run-1',
      attempt: 1,
      status: 'running',
      worktreeId: 'worker-1',
      worktreePath: 'D:/Temp/worker-1',
      branch: 'worker/worker-1',
      baseRevision: 'base-1',
    },
  },
};

describe('buildTaskGraphProjection', () => {
  it('creates stable task issues and is idempotent when the graph is projected again', () => {
    const graphWithoutIssueLinks: ProjectTaskGraph = {
      ...graph,
      tasks: graph.tasks.map(({ issueId: _issueId, ...task }) => task),
    };
    const first = materializeTaskIssues({
      graph: graphWithoutIssueLinks,
      projectId: 'project-1',
      existingIssues: [],
      now: '2026-09-12T01:04:00.000Z',
    });

    expect(first.createdIssueIds).toEqual([
      taskIssueId('task-graph-1', 'task-plan'),
      taskIssueId('task-graph-1', 'task-build'),
    ]);
    expect(first.issues.map((issue) => ({
      id: issue.id,
      status: issue.status,
      relatedTaskIds: issue.relatedTaskIds,
    }))).toEqual([
      { id: taskIssueId('task-graph-1', 'task-plan'), status: 'done', relatedTaskIds: ['task-plan'] },
      { id: taskIssueId('task-graph-1', 'task-build'), status: 'in_progress', relatedTaskIds: ['task-build'] },
    ]);

    const second = materializeTaskIssues({
      graph: graphWithoutIssueLinks,
      projectId: 'project-1',
      existingIssues: first.issues,
      now: '2026-09-12T01:05:00.000Z',
    });
    expect(second.createdIssueIds).toEqual([]);
    expect(second.issues).toEqual(first.issues);
  });

  it('keeps Task, Issue, dependency, and execution lineage addressable by the same task id', () => {
    const projection = buildTaskGraphProjection({
      graph,
      issues,
      execution,
      runId: 'run-1',
    });

    expect(projection).toMatchObject({
      graphId: 'task-graph-1',
      graphVersion: 3,
      runId: 'run-1',
    });
    expect(projection.edges).toEqual([{ fromTaskId: 'task-plan', toTaskId: 'task-build' }]);
    expect(projection.nodes).toEqual([
      expect.objectContaining({
        taskId: 'task-plan',
        issueId: 'issue-plan',
        projectedStatus: 'done',
        consistency: 'consistent',
      }),
      expect.objectContaining({
        taskId: 'task-build',
        issueId: 'issue-build',
        executionStatus: 'running',
        taskExecutionId: 'task-execution:run-1:task-build',
        attemptId: 'task-execution:run-1:task-build:attempt-1',
        evidenceIds: ['evidence-build'],
        acceptanceId: 'acceptance-build',
        projectedStatus: 'in_progress',
        consistency: 'consistent',
      }),
    ]);
  });

  it('does not project raw succeeded Worker tasks without provenance as done', () => {
    const run: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-invalid-success',
      orchestrationId: 'orchestration-1',
      taskGraphId: 'task-graph-1',
      taskGraphVersion: 3,
      status: 'running',
      createdAt: '2026-09-12T01:03:00.000Z',
      updatedAt: '2026-09-12T01:03:00.000Z',
      tasks: {
        'task-build': {
          taskId: 'task-build',
          taskExecutionId: 'task-execution:run-invalid-success:task-build',
          status: 'succeeded',
          attempt: 1,
          currentAttemptId: 'task-execution:run-invalid-success:task-build:attempt-1',
          evidenceIds: ['evidence-build'],
          updatedAt: '2026-09-12T01:03:00.000Z',
        },
      },
    };

    const projection = buildTaskGraphProjectionFromWorkerRun({ graph, issues, run });
    const node = projection.nodes.find((candidate) => candidate.taskId === 'task-build');
    expect(node).toEqual(expect.objectContaining({
      executionStatus: 'succeeded',
      projectedStatus: 'blocked',
      consistency: 'execution-lineage-drift',
    }));
  });
  it('adapts the durable WorkerRun registry into the same task projection', () => {
    const run: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orchestration-1',
      taskGraphId: 'task-graph-1',
      taskGraphVersion: 3,
      status: 'running',
      createdAt: '2026-09-12T01:03:00.000Z',
      updatedAt: '2026-09-12T01:03:00.000Z',
      tasks: {
        'task-build': {
          taskId: 'task-build',
          taskExecutionId: 'task-execution:run-1:task-build',
          status: 'running',
          attempt: 1,
          currentAttemptId: 'task-execution:run-1:task-build:attempt-1',
          worktreeId: 'worker-1',
          worktreePath: 'D:/Temp/worker-1',
          branch: 'worker/worker-1',
          baseRevision: 'base-1',
          evidenceIds: ['evidence-build'],
          acceptanceId: 'acceptance-build',
          updatedAt: '2026-09-12T01:03:00.000Z',
        },
      },
    };

    const projection = buildTaskGraphProjectionFromWorkerRun({
      graph,
      issues,
      run,
    });
    expect(projection.runId).toBe('run-1');
    expect(projection.nodes.find((node) => node.taskId === 'task-build')).toEqual(
      expect.objectContaining({
        executionStatus: 'running',
        taskExecutionId: 'task-execution:run-1:task-build',
        attemptId: 'task-execution:run-1:task-build:attempt-1',
        projectedStatus: 'in_progress',
        evidenceIds: ['evidence-build'],
        acceptanceId: 'acceptance-build',
      }),
    );
  });
});
