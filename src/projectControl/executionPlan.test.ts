import { describe, expect, it } from 'vitest';
import type { ProjectTaskGraph } from './types';
import { buildExecutionDraftFromTaskGraph } from './executionPlan';

const graph: ProjectTaskGraph = {
  version: 1,
  id: 'task-graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 1,
  approval: 'approved',
  createdAt: '2026-08-31T07:00:00.000Z',
  updatedAt: '2026-08-31T07:00:00.000Z',
  tasks: [{
    version: 1,
    id: 'task-1',
    architectureId: 'architecture-1',
    title: '实现账本',
    description: '完成账本模块',
    moduleId: 'ledger',
    scope: ['src/ledger/**'],
    dependsOn: [],
    acceptanceCriteria: ['可以记录收支'],
    category: 'logic',
    status: 'approved',
    createdAt: '2026-08-31T07:00:00.000Z',
    updatedAt: '2026-08-31T07:00:00.000Z',
  }],
};

describe('buildExecutionDraftFromTaskGraph', () => {
  it('creates construction and acceptance stages linked to approved tasks', () => {
    const draft = buildExecutionDraftFromTaskGraph({
      goal: '做一个个人记账应用',
      taskGraph: graph,
      workflowIds: { construction: 'wf-construction', acceptance: 'wf-acceptance' },
    });

    expect(draft.stages).toHaveLength(2);
    expect(draft.stages[0]).toMatchObject({
      id: 'construction',
      role: 'constructor',
      taskIds: ['task-1'],
      sourceTaskGraphId: 'task-graph-1',
      wfRef: { kind: 'existing', wfId: 'wf-construction' },
    });
    expect(draft.stages[1].wfRef).toEqual({ kind: 'existing', wfId: 'wf-acceptance' });
    expect(draft.edges).toEqual([
      expect.objectContaining({ from: 'construction', to: 'acceptance', artifactKind: 'project' }),
    ]);
  });

  it('rejects a task graph that is not approved or has no tasks', () => {
    expect(() => buildExecutionDraftFromTaskGraph({ goal: 'x', taskGraph: { ...graph, approval: 'draft' } })).toThrow(/批准/);
    expect(() => buildExecutionDraftFromTaskGraph({ goal: 'x', taskGraph: { ...graph, tasks: [] } })).toThrow(/任务/);
  });
});
