import type {
  ProjectArchitecture,
  ProjectTask,
  ProjectTaskGraph,
  ProjectTaskGraphRevisionChange,
} from './types';

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

export function reviseTaskGraph(input: {
  graph: ProjectTaskGraph;
  id: string;
  now: string;
  changes: readonly ProjectTaskGraphRevisionChange[];
}): ProjectTaskGraph {
  if (input.graph.approval === 'superseded') {
    throw new Error('已失效的任务图不能再次生成 revision');
  }
  const id = requiredText(input.id, '新任务图 id');
  if (id === input.graph.id) throw new Error('任务图 revision 必须使用新的 id');
  const changes = new Map<string, ProjectTaskGraphRevisionChange>();
  for (const change of input.changes) {
    const taskId = requiredText(change.taskId, 'revision task id');
    if (changes.has(taskId)) throw new Error(`revision 重复修改任务：${taskId}`);
    changes.set(taskId, { ...change, taskId });
  }
  const taskIds = new Set(input.graph.tasks.map((task) => task.id));
  for (const taskId of changes.keys()) {
    if (!taskIds.has(taskId)) throw new Error(`revision 任务不存在：${taskId}`);
  }
  const tasks = input.graph.tasks.map((task) => {
    const change = changes.get(task.id);
    const nextDependsOn = change?.dependsOn
      ? [...new Set(change.dependsOn.map((dependency) => requiredText(dependency, '任务依赖 id')))]
      : [...task.dependsOn];
    const { issueId: _oldIssueId, ...withoutIssueBinding } = task;
    return {
      ...withoutIssueBinding,
      ...(change?.title !== undefined ? { title: requiredText(change.title, '任务标题') } : {}),
      ...(change?.description !== undefined ? { description: requiredText(change.description, '任务描述') } : {}),
      dependsOn: nextDependsOn,
      status: 'proposed' as const,
      updatedAt: input.now,
    } satisfies ProjectTask;
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`任务 ${task.id} 依赖不存在的任务：${dependency}`);
      if (dependency === task.id) throw new Error(`任务图依赖存在环路：${task.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`任务图依赖存在环路：${taskId}`);
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);

  return {
    ...input.graph,
    id,
    graphVersion: input.graph.graphVersion + 1,
    tasks,
    approval: 'draft',
    createdAt: input.now,
    updatedAt: input.now,
    approvedBy: undefined,
    approvedAt: undefined,
    revisionOf: input.graph.id,
    supersededBy: undefined,
  };
}
