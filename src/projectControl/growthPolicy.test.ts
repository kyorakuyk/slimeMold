import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from './types';
import { checkGrowth } from './growthPolicy';
import { triageTaskGraph } from './triage';

const task = (overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  version: 1,
  id: 'task-1',
  architectureId: 'architecture-1',
  title: '写一个 helloworld.py',
  description: '实现最小可运行示例',
  moduleId: 'hello',
  scope: ['helloworld.py'],
  dependsOn: [],
  acceptanceCriteria: ['运行输出 Hello, World!'],
  category: 'logic',
  status: 'proposed',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  ...overrides,
});

const graph = (tasks: ProjectTask[]): ProjectTaskGraph => ({
  version: 1,
  id: 'task-graph-1',
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  graphVersion: 1,
  tasks,
  approval: 'draft',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
});

describe('checkGrowth', () => {
  it('accepts the one-task helloworld baseline without violations', () => {
    const input = graph([task()]);
    const triage = triageTaskGraph(input);

    expect(triage.level).toBe('L0');
    expect(checkGrowth(input, triage)).toEqual([]);
  });

  it('reports tasks without acceptance criteria as not independently verifiable', () => {
    const input = graph([task({ id: 'task-no-acceptance', acceptanceCriteria: [] })]);

    expect(checkGrowth(input, triageTaskGraph(input))).toEqual([
      {
        code: 'not-independently-verifiable',
        taskIds: ['task-no-acceptance'],
        message: '任务“task-no-acceptance”没有验收标准，无法独立验收。',
      },
    ]);
  });

  it('reports independently planned tasks that share a file', () => {
    const input = graph([
      task({ id: 'task-a', moduleId: 'module-a', scope: ['shared.ts'] }),
      task({ id: 'task-b', moduleId: 'module-b', scope: ['shared.ts'] }),
    ]);

    expect(checkGrowth(input, triageTaskGraph(input))).toEqual([
      {
        code: 'overlapping-scope',
        taskIds: ['task-a', 'task-b'],
        message: '任务“task-a”和“task-b”共享文件 shared.ts，且不存在直接或间接依赖。',
      },
    ]);
  });

  it('does not flag shared scope when tasks have an indirect dependency path', () => {
    const input = graph([
      task({ id: 'task-a', moduleId: 'module-a', scope: ['shared.ts'] }),
      task({ id: 'task-b', moduleId: 'module-b', scope: ['shared.ts'], dependsOn: ['task-a'] }),
      task({ id: 'task-c', moduleId: 'module-c', scope: ['shared.ts'], dependsOn: ['task-b'] }),
    ]);

    expect(checkGrowth(input, triageTaskGraph(input))).toEqual([]);
  });

  it('reports over-growth, missing acceptance, and independent overlap in the B0 benchmark', () => {
    const input = graph([
      task({ id: 't1', title: '导入包' }),
      task({ id: 't2', title: '定义函数', acceptanceCriteria: [], dependsOn: ['t1'] }),
      task({ id: 't3', title: '实现函数', dependsOn: ['t1'] }),
      task({ id: 't4', title: '写测试', scope: ['test_helloworld.py'], dependsOn: ['t3'] }),
    ]);
    const triage = triageTaskGraph(input);

    expect(triage.level).toBe('L0');
    expect(checkGrowth(input, triage)).toEqual([
      {
        code: 'over-growth',
        taskIds: ['t1', 't2', 't3', 't4'],
        message: 'L0 任务图包含 4 个任务，建议合并为 1 个直通任务。',
      },
      {
        code: 'not-independently-verifiable',
        taskIds: ['t2'],
        message: '任务“t2”没有验收标准，无法独立验收。',
      },
      {
        code: 'overlapping-scope',
        taskIds: ['t2', 't3'],
        message: '任务“t2”和“t3”共享文件 helloworld.py，且不存在直接或间接依赖。',
      },
    ]);
  });
});
