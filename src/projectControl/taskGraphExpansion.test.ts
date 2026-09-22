import { describe, expect, it } from 'vitest';
import {
  approveTaskGraphExpansion,
  proposeTaskGraphExpansion,
} from './taskGraphExpansion';
import type { ProjectTask, ProjectTaskGraph } from './types';

function task(id: string, dependsOn: string[] = [], status: ProjectTask['status'] = 'approved'): ProjectTask {
  return {
    version: 1,
    id,
    architectureId: 'architecture-1',
    title: `任务 ${id}`,
    description: `执行 ${id}`,
    moduleId: 'module-1',
    scope: [`src/${id}`],
    dependsOn,
    acceptanceCriteria: [`${id} 通过测试`],
    category: 'implementation',
    status,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

function graph(tasks: ProjectTask[]): ProjectTaskGraph {
  return {
    version: 1,
    id: 'graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 2,
    tasks,
    approval: 'approved',
    approvedBy: 'user',
    approvedAt: '2026-09-12T00:00:00.000Z',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

describe('task graph expansion', () => {
  it('requires a bounded proposal and approval before adding dynamic tasks', () => {
    const base = graph([task('task-a')]);
    const proposal = proposeTaskGraphExpansion({
      proposalId: 'expansion-1',
      graph: base,
      sourceTaskId: 'task-a',
      reason: '测试发现需要补充兼容层',
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      proposedGraphId: 'graph-2',
      addedTasks: [task('task-b', ['task-a'], 'proposed')],
      maxNewTasks: 2,
      maxDepth: 2,
      maxFanout: 2,
      now: '2026-09-12T01:00:00.000Z',
    });

    expect(proposal).toMatchObject({
      status: 'proposed',
      baseGraphId: 'graph-1',
      baseGraphVersion: 2,
      newTaskIds: ['task-b'],
    });
    expect(base.tasks).toHaveLength(1);

    const approved = approveTaskGraphExpansion(proposal, base, 'master', '2026-09-12T01:01:00.000Z');
    expect(approved.graph).toMatchObject({ id: 'graph-2', graphVersion: 3, approval: 'draft' });
    expect(approved.graph.tasks.map((item) => item.id)).toEqual(['task-a', 'task-b']);
    expect(approved.proposal).toMatchObject({ status: 'approved', approvedBy: 'master' });
  });

  it('rejects expansion of a running graph or an unbounded/cyclic proposal', () => {
    expect(() => proposeTaskGraphExpansion({
      proposalId: 'expansion-running',
      graph: graph([task('task-a', [], 'in_progress')]),
      sourceTaskId: 'task-a',
      reason: '运行中扩展',
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      proposedGraphId: 'graph-2',
      addedTasks: [task('task-b', ['task-a'], 'proposed')],
      maxNewTasks: 2,
      maxDepth: 2,
      maxFanout: 2,
      now: '2026-09-12T01:00:00.000Z',
    })).toThrow(/running|运行/);

    const base = graph([task('task-a')]);
    expect(() => proposeTaskGraphExpansion({
      proposalId: 'expansion-cycle',
      graph: base,
      sourceTaskId: 'task-a',
      reason: '循环扩展',
      evidenceRefs: [{ id: 'evidence-1', version: 1 }],
      proposedGraphId: 'graph-2',
      addedTasks: [task('task-b', ['task-b'], 'proposed')],
      maxNewTasks: 0,
      maxDepth: 1,
      maxFanout: 1,
      now: '2026-09-12T01:00:00.000Z',
    })).toThrow(/bounded|上限|环/);
  });

  it('supports bounded multi-level expansion from the source task', () => {
    const base = graph([task('task-a')]);
    const proposal = proposeTaskGraphExpansion({
      proposalId: 'expansion-depth',
      graph: base,
      sourceTaskId: 'task-a',
      reason: '需要两层验证任务',
      evidenceRefs: [{ id: 'evidence-depth', version: 1 }],
      proposedGraphId: 'graph-depth',
      addedTasks: [
        task('task-b', ['task-a'], 'proposed'),
        task('task-c', ['task-b'], 'proposed'),
      ],
      maxNewTasks: 2,
      maxDepth: 2,
      maxFanout: 2,
      now: '2026-09-12T02:00:00.000Z',
    });

    expect(proposal.newTaskIds).toEqual(['task-b', 'task-c']);
  });

  it('revalidates proposal tasks when approval receives a tampered proposal', () => {
    const base = graph([task('task-a')]);
    const proposal = proposeTaskGraphExpansion({
      proposalId: 'expansion-tamper',
      graph: base,
      sourceTaskId: 'task-a',
      reason: '验证审批重检',
      evidenceRefs: [{ id: 'evidence-tamper', version: 1 }],
      proposedGraphId: 'graph-tamper',
      addedTasks: [task('task-b', ['task-a'], 'proposed')],
      maxNewTasks: 1,
      maxDepth: 1,
      maxFanout: 1,
      now: '2026-09-12T03:00:00.000Z',
    });
    const tampered = {
      ...proposal,
      addedTasks: [task('task-evil', ['task-a'], 'approved')],
    };

    expect(() => approveTaskGraphExpansion(tampered, base, 'master', '2026-09-12T03:01:00.000Z'))
      .toThrow(/proposed|task|校验/);
  });
});
