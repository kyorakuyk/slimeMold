import { describe, expect, it } from 'vitest';
import {
  buildManagerBrief,
  buildTaskProgressCapsule,
} from './progressSummary';
import type { TaskGraphProjection } from './taskGraphProjection';

const projection: TaskGraphProjection = {
  graphId: 'graph-1',
  graphVersion: 2,
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  approval: 'approved',
  nodes: [
    {
      graphId: 'graph-1',
      taskId: 'task-done',
      issueId: 'issue-done',
      title: '已完成任务',
      description: '完成一个模块',
      taskStatus: 'done',
      issueStatus: 'done',
      executionStatus: 'succeeded',
      projectedStatus: 'done',
      dependsOn: [],
      taskExecutionId: 'execution-done',
      runId: 'run-1',
      attemptId: 'attempt-done',
      evidenceIds: ['evidence-1'],
      acceptanceId: 'acceptance-1',
      consistency: 'consistent',
    },
    {
      graphId: 'graph-1',
      taskId: 'task-blocked',
      issueId: 'issue-blocked',
      title: '阻塞任务',
      description: '等待决策',
      taskStatus: 'blocked',
      issueStatus: 'blocked',
      executionStatus: 'blocked',
      projectedStatus: 'blocked',
      dependsOn: ['task-done'],
      evidenceIds: [],
      consistency: 'consistent',
    },
  ],
  edges: [{ fromTaskId: 'task-done', toTaskId: 'task-blocked' }],
};

describe('evidence-backed progress summaries', () => {
  it('builds a task capsule from the canonical projection without raw transcript data', () => {
    const summary = buildTaskProgressCapsule({
      projection,
      taskId: 'task-done',
      summaryId: 'summary-task-done',
      sourceVersion: 7,
      now: '2026-09-12T10:00:00.000Z',
      staleAt: '2026-09-12T11:00:00.000Z',
    });

    expect(summary).toMatchObject({
      summaryId: 'summary-task-done',
      subjectId: 'task-done',
      scope: 'task',
      sourceVersion: 7,
      status: 'completed',
      completionBasis: 'evidence-backed',
      evidenceRefs: ['evidence-1'],
      acceptanceRefs: ['acceptance-1'],
      childTaskSummary: { total: 1, completed: 1 },
    });
    expect(summary).not.toHaveProperty('transcript');
  });

  it('aggregates a partial Manager brief with blockers and evidence references', () => {
    const summary = buildManagerBrief({
      projection,
      summaryId: 'summary-project-1',
      sourceVersion: 7,
      now: '2026-09-12T10:00:00.000Z',
      staleAt: '2026-09-12T11:00:00.000Z',
    });

    expect(summary).toMatchObject({
      summaryId: 'summary-project-1',
      subjectId: 'graph-1',
      scope: 'project',
      status: 'partial',
      evidenceRefs: ['evidence-1'],
      acceptanceRefs: ['acceptance-1'],
      childTaskSummary: { total: 2, completed: 1, blocked: 1 },
      decisionNeeded: true,
    });
    expect(summary.blockers).toEqual(['task-blocked']);
  });

  it('turns a consistency drift into unknown instead of completed', () => {
    const drifted = {
      ...projection,
      nodes: projection.nodes.map((node) => node.taskId === 'task-done'
        ? { ...node, consistency: 'execution-lineage-drift' as const }
        : node),
    };
    const summary = buildManagerBrief({
      projection: drifted,
      summaryId: 'summary-project-drift',
      sourceVersion: 8,
      now: '2026-09-12T10:00:00.000Z',
      staleAt: '2026-09-12T11:00:00.000Z',
    });

    expect(summary.status).toBe('unknown');
    expect(summary.decisionNeeded).toBe(true);
    expect(summary.consistency).toBe('inconsistent');
  });
});
