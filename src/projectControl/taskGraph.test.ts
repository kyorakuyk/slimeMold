import { describe, expect, it } from 'vitest';
import type { ProjectArchitecture } from './types';
import { approveTaskGraph, createTaskGraphFromArchitecture } from './taskGraph';

const architecture: ProjectArchitecture = {
  version: 1,
  id: 'architecture-1',
  sessionId: 'session-1',
  briefId: 'brief-1',
  architectureVersion: 2,
  overview: '分层本地应用',
  modules: [{
    id: 'ledger',
    name: '账本模块',
    responsibility: '管理收支',
    category: 'logic',
    scope: ['src/ledger/**'],
    dependsOn: [],
  }],
  interfaces: [],
  tasks: [{
    id: 'ledger-model',
    title: '实现模型',
    description: '定义收支模型',
    moduleId: 'ledger',
    scope: ['src/ledger/model.ts'],
    dependsOn: [],
    acceptanceCriteria: ['可以保存一条记录'],
    category: 'logic',
  }],
  risks: [],
  approval: 'approved',
  createdAt: '2026-08-31T06:00:00.000Z',
  updatedAt: '2026-08-31T06:00:00.000Z',
};

describe('ProjectTaskGraph', () => {
  it('compiles approved architecture tasks into proposed project tasks', () => {
    const graph = createTaskGraphFromArchitecture({
      id: 'task-graph-1',
      architecture,
      now: '2026-08-31T06:01:00.000Z',
    });

    expect(graph).toMatchObject({
      id: 'task-graph-1',
      sessionId: 'session-1',
      architectureId: 'architecture-1',
      graphVersion: 1,
      approval: 'draft',
    });
    expect(graph.tasks).toEqual([
      expect.objectContaining({
        id: 'ledger-model',
        architectureId: 'architecture-1',
        status: 'proposed',
        scope: ['src/ledger/model.ts'],
        acceptanceCriteria: ['可以保存一条记录'],
      }),
    ]);
  });

  it('approves the graph and all its tasks explicitly', () => {
    const graph = createTaskGraphFromArchitecture({
      id: 'task-graph-1',
      architecture,
      now: '2026-08-31T06:01:00.000Z',
    });
    const approved = approveTaskGraph(graph, 'user', '2026-08-31T06:02:00.000Z');

    expect(graph.approval).toBe('draft');
    expect(approved).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(approved.tasks.every((task) => task.status === 'approved')).toBe(true);
  });

  it('rejects compiling an architecture that is not approved', () => {
    expect(() => createTaskGraphFromArchitecture({
      id: 'task-graph-1',
      architecture: { ...architecture, approval: 'draft' },
      now: '2026-08-31T06:01:00.000Z',
    })).toThrow(/批准/);
  });
});
