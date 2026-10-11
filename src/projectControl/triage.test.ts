import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskGraph } from './types';
import {
  L0_MAX_FILES,
  TRIAGE_RULES_VERSION,
  triageTaskGraph,
} from './triage';

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

describe('triageTaskGraph', () => {
  it('classifies a one-task, one-file helloworld graph as L0', () => {
    const input = graph([task()]);

    expect(triageTaskGraph(input)).toEqual({
      level: 'L0',
      reasons: ['L0：单模块 hello，涉及 1 个文件（上限 2）。'],
      rulesVersion: TRIAGE_RULES_VERSION,
    });
    expect(TRIAGE_RULES_VERSION).toBe(1);
  });

  it('falls back to L1 when one module spans more than the L0 file limit', () => {
    const scope = Array.from({ length: L0_MAX_FILES + 1 }, (_, index) => `file-${index + 1}.ts`);
    const input = graph([task({ scope })]);

    expect(triageTaskGraph(input)).toEqual({
      level: 'L1',
      reasons: [`L1：涉及 1 个模块和 ${scope.length} 个文件，未达到 L0/L2 门槛。`],
      rulesVersion: TRIAGE_RULES_VERSION,
    });
  });

  it('classifies graphs at the distinct-module threshold as L2', () => {
    const tasks = Array.from({ length: 3 }, (_, index) => task({
      id: `task-${index + 1}`,
      moduleId: `module-${index + 1}`,
      scope: [`module-${index + 1}.ts`],
    }));

    expect(triageTaskGraph(graph(tasks))).toEqual({
      level: 'L2',
      reasons: ['L2：涉及 3 个模块（门槛 3）。'],
      rulesVersion: TRIAGE_RULES_VERSION,
    });
  });

  it('classifies a sufficiently large cross-module dependency graph as L2', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task({
      id: `task-${index + 1}`,
      moduleId: index === 0 ? 'core' : 'api',
      scope: [`module-${index + 1}.ts`],
      dependsOn: index === 1 ? ['task-1'] : [],
    }));

    expect(triageTaskGraph(graph(tasks))).toEqual({
      level: 'L2',
      reasons: ['L2：存在跨模块依赖，包含 6 个任务（门槛 6）。'],
      rulesVersion: TRIAGE_RULES_VERSION,
    });
  });
});
