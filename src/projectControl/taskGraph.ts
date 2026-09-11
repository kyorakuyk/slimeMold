import type { ProjectArchitecture, ProjectTask, ProjectTaskGraph } from './types';

export interface CreateTaskGraphInput {
  id: string;
  architecture: ProjectArchitecture;
  now: string;
  version?: number;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

export function createTaskGraphFromArchitecture(input: CreateTaskGraphInput): ProjectTaskGraph {
  if (input.architecture.approval !== 'approved') {
    throw new Error(`架构尚未批准，不能生成任务图：${input.architecture.approval}`);
  }
  const tasks: ProjectTask[] = input.architecture.tasks.map((task) => ({
    version: 1,
    id: requiredText(task.id, '任务 id'),
    architectureId: input.architecture.id,
    title: requiredText(task.title, '任务标题'),
    description: requiredText(task.description, '任务描述'),
    moduleId: requiredText(task.moduleId, '任务模块 id'),
    scope: [...task.scope],
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: [...task.acceptanceCriteria],
    category: requiredText(task.category, '任务 category'),
    status: 'proposed',
    createdAt: input.now,
    updatedAt: input.now,
  }));
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('任务图中的任务 id 不能重复');
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`任务 ${task.id} 依赖不存在的任务：${dependency}`);
    }
  }

  return {
    version: 1,
    id: requiredText(input.id, '任务图 id'),
    sessionId: input.architecture.sessionId,
    architectureId: input.architecture.id,
    graphVersion: input.version ?? 1,
    tasks,
    approval: 'draft',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function approveTaskGraph(
  graph: ProjectTaskGraph,
  approvedBy: string,
  now: string,
): ProjectTaskGraph {
  if (graph.approval !== 'draft') {
    throw new Error(`任务图已批准或已失效：${graph.approval}`);
  }
  const approver = requiredText(approvedBy, '批准人');
  return {
    ...graph,
    approval: 'approved',
    approvedBy: approver,
    approvedAt: now,
    updatedAt: now,
    tasks: graph.tasks.map((task) => ({ ...task, status: 'approved', updatedAt: now })),
  };
}
