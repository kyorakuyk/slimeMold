import { reviseTaskGraph } from './taskGraph';
import type {
  PlanningReference,
  ProjectTask,
  ProjectTaskGraph,
} from './types';

export interface TaskGraphExpansionProposal {
  version: 1;
  proposalId: string;
  baseGraphId: string;
  baseGraphVersion: number;
  proposedGraphId: string;
  sourceTaskId: string;
  reason: string;
  evidenceRefs: readonly PlanningReference[];
  addedTasks: readonly ProjectTask[];
  newTaskIds: readonly string[];
  maxNewTasks: number;
  maxDepth: number;
  maxFanout: number;
  status: 'proposed' | 'approved' | 'rejected';
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ProposeTaskGraphExpansionInput {
  proposalId: string;
  graph: ProjectTaskGraph;
  sourceTaskId: string;
  reason: string;
  evidenceRefs: readonly PlanningReference[];
  proposedGraphId: string;
  addedTasks: readonly ProjectTask[];
  maxNewTasks: number;
  maxDepth: number;
  maxFanout: number;
  now: string;
}

export interface ApprovedTaskGraphExpansion {
  proposal: TaskGraphExpansionProposal;
  graph: ProjectTaskGraph;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是正整数，上限必须明确`);
  return value;
}

function referenceList(value: readonly PlanningReference[]): PlanningReference[] {
  if (value.length === 0) throw new Error('DAG expansion 必须引用至少一条 Evidence');
  return value.map((reference) => {
    const id = requiredText(reference.id, 'evidence reference id');
    const version = positiveInteger(reference.version, 'evidence reference version');
    return { id, version };
  });
}

function assertTaskGraphIsIdle(graph: ProjectTaskGraph): void {
  if (graph.tasks.some((task) => task.status === 'in_progress')) {
    throw new Error('running TaskGraph 不能直接扩展，必须先形成新的计划 revision');
  }
}

function assertExpandedTasks(
  graph: ProjectTaskGraph,
  sourceTaskId: string,
  addedTasks: readonly ProjectTask[],
  maxDepth: number,
  maxFanout: number,
): ProjectTask[] {
  const existingIds = new Set(graph.tasks.map((task) => task.id));
  const addedIds = new Set<string>();
  for (const task of addedTasks) {
    const id = requiredText(task.id, '新增 task id');
    if (existingIds.has(id) || addedIds.has(id)) throw new Error(`DAG expansion task id 重复：${id}`);
    addedIds.add(id);
    if (task.version !== 1 || task.architectureId !== graph.architectureId) {
      throw new Error(`新增 task 不属于当前 architecture：${id}`);
    }
    if (task.status !== 'proposed') throw new Error(`新增 task 必须处于 proposed：${id}`);
  }

  const allIds = new Set([...existingIds, ...addedIds]);
  const allTasks = [...graph.tasks, ...addedTasks];
  const childrenByParent = new Map<string, number>();
  for (const task of allTasks) {
    for (const dependency of task.dependsOn) {
      if (!allIds.has(dependency)) throw new Error(`DAG expansion 依赖不存在：${task.id}/${dependency}`);
      childrenByParent.set(dependency, (childrenByParent.get(dependency) ?? 0) + 1);
    }
  }
  for (const [parent, count] of childrenByParent) {
    if (count > maxFanout) throw new Error(`DAG expansion 超出 fan-out 上限：${parent}`);
  }

  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const depthFromSource = new Map<string, number>([[sourceTaskId, 0]]);
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`DAG expansion 存在依赖环路：${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = byId.get(taskId);
    if (!task) throw new Error(`DAG expansion 缺少 task：${taskId}`);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of allTasks) visit(task.id);

  const children = new Map<string, string[]>();
  for (const task of allTasks) {
    for (const dependency of task.dependsOn) {
      const next = children.get(dependency) ?? [];
      next.push(task.id);
      children.set(dependency, next);
    }
  }
  const pending = [{ taskId: sourceTaskId, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const child of children.get(current.taskId) ?? []) {
      const depth = current.depth + 1;
      if (addedIds.has(child) && depth > maxDepth) throw new Error(`DAG expansion 超出 depth 上限：${child}`);
      const previousDepth = depthFromSource.get(child);
      if (previousDepth !== undefined && previousDepth <= depth) continue;
      depthFromSource.set(child, depth);
      pending.push({ taskId: child, depth });
    }
  }
  for (const task of addedTasks) {
    if (!depthFromSource.has(task.id)) {
      throw new Error(`新增 task 无法从 source task 到达：${task.id}`);
    }
  }
  return addedTasks.map((task) => ({
    ...task,
    scope: [...task.scope],
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: [...task.acceptanceCriteria],
  }));
}

export function proposeTaskGraphExpansion(
  input: ProposeTaskGraphExpansionInput,
): TaskGraphExpansionProposal {
  assertTaskGraphIsIdle(input.graph);
  const proposalId = requiredText(input.proposalId, 'proposalId');
  const sourceTaskId = requiredText(input.sourceTaskId, 'sourceTaskId');
  if (!input.graph.tasks.some((task) => task.id === sourceTaskId)) {
    throw new Error(`source task 不存在：${sourceTaskId}`);
  }
  const proposedGraphId = requiredText(input.proposedGraphId, 'proposedGraphId');
  if (proposedGraphId === input.graph.id) throw new Error('expansion 必须使用新的 graph id');
  const reason = requiredText(input.reason, 'expansion reason');
  const evidenceRefs = referenceList(input.evidenceRefs);
  const maxNewTasks = positiveInteger(input.maxNewTasks, 'maxNewTasks');
  const maxDepth = positiveInteger(input.maxDepth, 'maxDepth');
  const maxFanout = positiveInteger(input.maxFanout, 'maxFanout');
  if (input.addedTasks.length > maxNewTasks) throw new Error('DAG expansion 超出 bounded maxNewTasks 上限');
  const addedTasks = assertExpandedTasks(input.graph, sourceTaskId, input.addedTasks, maxDepth, maxFanout);
  return {
    version: 1,
    proposalId,
    baseGraphId: input.graph.id,
    baseGraphVersion: input.graph.graphVersion,
    proposedGraphId,
    sourceTaskId,
    reason,
    evidenceRefs,
    addedTasks,
    newTaskIds: addedTasks.map((task) => task.id),
    maxNewTasks,
    maxDepth,
    maxFanout,
    status: 'proposed',
    createdAt: requiredText(input.now, 'createdAt'),
  };
}

export function approveTaskGraphExpansion(
  proposal: TaskGraphExpansionProposal,
  graph: ProjectTaskGraph,
  approvedBy: string,
  now: string,
): ApprovedTaskGraphExpansion {
  if (proposal.status !== 'proposed') throw new Error(`expansion proposal 当前不可批准：${proposal.status}`);
  if (graph.approval !== 'approved') throw new Error(`base graph 尚未批准：${graph.approval}`);
  if (proposal.baseGraphId !== graph.id || proposal.baseGraphVersion !== graph.graphVersion) {
    throw new Error('expansion proposal 基于旧 graph，拒绝批准');
  }
  assertTaskGraphIsIdle(graph);
  const revalidatedEvidenceRefs = referenceList(proposal.evidenceRefs);
  const maxNewTasks = positiveInteger(proposal.maxNewTasks, 'maxNewTasks');
  const maxDepth = positiveInteger(proposal.maxDepth, 'maxDepth');
  const maxFanout = positiveInteger(proposal.maxFanout, 'maxFanout');
  if (proposal.addedTasks.length > maxNewTasks) throw new Error('DAG expansion proposal 超出 maxNewTasks 上限');
  const revalidatedTasks = assertExpandedTasks(
    graph,
    requiredText(proposal.sourceTaskId, 'sourceTaskId'),
    proposal.addedTasks,
    maxDepth,
    maxFanout,
  );
  if (JSON.stringify(proposal.newTaskIds) !== JSON.stringify(revalidatedTasks.map((task) => task.id))) {
    throw new Error('expansion proposal 的 newTaskIds 与 addedTasks 不一致');
  }
  if (JSON.stringify(revalidatedEvidenceRefs) !== JSON.stringify(proposal.evidenceRefs)) {
    throw new Error('expansion proposal Evidence refs 无法重新验证');
  }
  const approver = requiredText(approvedBy, 'approvedBy');
  const approvedAt = requiredText(now, 'approvedAt');
  const revised = reviseTaskGraph({ graph, id: proposal.proposedGraphId, now: approvedAt, changes: [] });
  const nextGraph: ProjectTaskGraph = {
    ...revised,
    tasks: [
      ...revised.tasks,
      ...revalidatedTasks.map((task) => ({
        ...task,
        status: 'proposed' as const,
        scope: [...task.scope],
        dependsOn: [...task.dependsOn],
        acceptanceCriteria: [...task.acceptanceCriteria],
        updatedAt: approvedAt,
      })),
    ],
  };
  return {
    proposal: {
      ...proposal,
      evidenceRefs: revalidatedEvidenceRefs,
      addedTasks: revalidatedTasks,
      newTaskIds: revalidatedTasks.map((task) => task.id),
      status: 'approved',
      approvedBy: approver,
      approvedAt,
    },
    graph: nextGraph,
  };
}
