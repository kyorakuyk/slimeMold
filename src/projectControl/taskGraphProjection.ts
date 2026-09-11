import type {
  DomainProjection,
  TaskExecutionProjection,
  TaskProjectionStatus,
} from '../domain/contracts';
import { createIssue } from './issue';
import type {
  ProjectIssue,
  ProjectIssueStatus,
  ProjectIssueType,
  ProjectTask,
  ProjectTaskGraph,
  ProjectTaskStatus,
} from './types';

export type TaskGraphProjectionConsistency =
  | 'consistent'
  | 'missing-issue'
  | 'task-issue-link-drift'
  | 'issue-status-drift'
  | 'execution-lineage-drift';

export interface TaskGraphProjectionNode {
  taskId: string;
  issueId?: string;
  title: string;
  description: string;
  taskStatus: ProjectTaskStatus;
  issueStatus?: ProjectIssueStatus;
  executionStatus?: TaskProjectionStatus;
  projectedStatus: ProjectIssueStatus;
  dependsOn: readonly string[];
  workflowId?: string;
  stageId?: string;
  taskExecutionId?: string;
  runId?: string;
  attemptId?: string;
  evidenceIds: readonly string[];
  acceptanceId?: string;
  cleanupStatus?: 'cleaned';
  error?: string;
  consistency: TaskGraphProjectionConsistency;
}

export interface TaskGraphProjectionEdge {
  fromTaskId: string;
  toTaskId: string;
}

export interface TaskGraphProjection {
  graphId: string;
  graphVersion: number;
  sessionId: string;
  architectureId: string;
  approval: ProjectTaskGraph['approval'];
  runId?: string;
  nodes: readonly TaskGraphProjectionNode[];
  edges: readonly TaskGraphProjectionEdge[];
}

export interface BuildTaskGraphProjectionInput {
  graph: ProjectTaskGraph;
  issues: readonly ProjectIssue[];
  execution: DomainProjection;
  runId?: string;
}

export interface MaterializeTaskIssuesInput {
  graph: ProjectTaskGraph;
  projectId: string;
  existingIssues: readonly ProjectIssue[];
  now: string;
}

export interface MaterializeTaskIssuesResult {
  issues: ProjectIssue[];
  createdIssueIds: string[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

export function taskIssueId(taskGraphId: string, taskId: string): string {
  return `issue:task:${requiredText(taskGraphId, '任务图 id')}:${requiredText(taskId, '任务 id')}`;
}

function taskCategoryToIssueType(category: string): ProjectIssueType {
  switch (category.trim().toLowerCase()) {
    case 'bug':
      return 'bug';
    case 'risk':
      return 'risk';
    case 'question':
      return 'question';
    case 'idea':
      return 'idea';
    default:
      return 'feature';
  }
}

export function materializeTaskIssues(
  input: MaterializeTaskIssuesInput,
): MaterializeTaskIssuesResult {
  const projectId = requiredText(input.projectId, '项目 id');
  const now = requiredText(input.now, '时间');
  const issues = [...input.existingIssues];
  const byId = new Map<string, ProjectIssue>();
  for (const issue of issues) {
    if (byId.has(issue.id)) throw new Error(`Issue 存在重复 id：${issue.id}`);
    byId.set(issue.id, issue);
  }
  const createdIssueIds: string[] = [];

  for (const task of input.graph.tasks) {
    const id = task.issueId ?? taskIssueId(input.graph.id, task.id);
    const existing = byId.get(id);
    if (existing) {
      if (existing.projectId !== projectId) {
        throw new Error(`Task Issue 已绑定其它项目：${id}`);
      }
      if (existing.relatedTaskIds.includes(task.id)) continue;
      const linked = {
        ...existing,
        relatedTaskIds: [...existing.relatedTaskIds, task.id],
        updatedAt: now,
      };
      const index = issues.findIndex((issue) => issue.id === id);
      issues[index] = linked;
      byId.set(id, linked);
      continue;
    }

    const issue = createIssue({
      id,
      projectId,
      type: taskCategoryToIssueType(task.category),
      title: task.title,
      description: task.description,
      relatedTaskIds: [task.id],
      createdAt: now,
    });
    const projectedIssue = { ...issue, status: taskStatusToIssueStatus(task.status) };
    issues.push(projectedIssue);
    byId.set(id, projectedIssue);
    createdIssueIds.push(id);
  }

  return { issues, createdIssueIds };
}

export function taskStatusToIssueStatus(status: ProjectTaskStatus): ProjectIssueStatus {
  switch (status) {
    case 'proposed':
      return 'proposed';
    case 'approved':
      return 'approved';
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'review':
      return 'review';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
  }
}

function executionStatusToIssueStatus(status: TaskProjectionStatus): ProjectIssueStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'blocked';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
  }
}

function executionsForTask(
  execution: DomainProjection,
  taskId: string,
  runId: string | undefined,
): TaskExecutionProjection[] {
  return Object.values(execution.taskExecutions).filter((candidate) => (
    candidate.taskId === taskId && (runId === undefined || candidate.runId === runId)
  ));
}

function selectedExecution(
  execution: DomainProjection,
  task: ProjectTask,
  runId: string | undefined,
): TaskExecutionProjection | undefined {
  const matches = executionsForTask(execution, task.id, runId);
  if (matches.length > 1) {
    throw new Error(`任务存在多个执行投影，必须明确 runId：${task.id}`);
  }
  return matches[0];
}

function issueConsistency(
  task: ProjectTask,
  issue: ProjectIssue | undefined,
  projectedStatus: ProjectIssueStatus,
  taskExecution: TaskExecutionProjection | undefined,
  execution: DomainProjection,
): TaskGraphProjectionConsistency {
  if (!issue) return 'missing-issue';
  if (!issue.relatedTaskIds.includes(task.id)) return 'task-issue-link-drift';
  if (taskExecution?.currentAttemptId) {
    const attempt = execution.attempts[taskExecution.currentAttemptId];
    if (!attempt || attempt.taskExecutionId !== taskExecution.taskExecutionId) {
      return 'execution-lineage-drift';
    }
  }
  if (issue.status !== projectedStatus) return 'issue-status-drift';
  return 'consistent';
}

function assertGraphIntegrity(graph: ProjectTaskGraph): Map<string, ProjectTask> {
  const byId = new Map<string, ProjectTask>();
  for (const task of graph.tasks) {
    if (byId.has(task.id)) throw new Error(`任务图存在重复 taskId：${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`任务 ${task.id} 依赖不存在的任务：${dependency}`);
      }
    }
  }
  return byId;
}

export function buildTaskGraphProjection(
  input: BuildTaskGraphProjectionInput,
): TaskGraphProjection {
  assertGraphIntegrity(input.graph);
  const issueById = new Map<string, ProjectIssue>();
  for (const issue of input.issues) {
    if (issueById.has(issue.id)) throw new Error(`Issue 存在重复 id：${issue.id}`);
    issueById.set(issue.id, issue);
  }

  const nodes = input.graph.tasks.map((task) => {
    const issueId = task.issueId ?? taskIssueId(input.graph.id, task.id);
    const issue = issueById.get(issueId);
    const taskExecution = selectedExecution(input.execution, task, input.runId);
    const projectedStatus = taskExecution
      ? executionStatusToIssueStatus(taskExecution.status)
      : taskStatusToIssueStatus(task.status);
    const consistency = issueConsistency(
      task,
      issue,
      projectedStatus,
      taskExecution,
      input.execution,
    );
    const attemptId = taskExecution?.currentAttemptId;

    return {
      taskId: task.id,
      issueId,
      title: task.title,
      description: task.description,
      taskStatus: task.status,
      ...(issue ? { issueStatus: issue.status } : {}),
      ...(taskExecution ? { executionStatus: taskExecution.status } : {}),
      projectedStatus,
      dependsOn: [...task.dependsOn],
      ...(task.workflowId ? { workflowId: task.workflowId } : {}),
      ...(task.stageId ? { stageId: task.stageId } : {}),
      ...(taskExecution ? {
        taskExecutionId: taskExecution.taskExecutionId,
        runId: taskExecution.runId,
        ...(attemptId ? { attemptId } : {}),
        evidenceIds: [...(taskExecution.evidenceIds ?? [])],
        ...(taskExecution.acceptanceId ? { acceptanceId: taskExecution.acceptanceId } : {}),
        ...(taskExecution.cleanupStatus ? { cleanupStatus: taskExecution.cleanupStatus } : {}),
        ...(taskExecution.error ? { error: taskExecution.error } : {}),
      } : { evidenceIds: [] }),
      consistency,
    } satisfies TaskGraphProjectionNode;
  });

  return {
    graphId: input.graph.id,
    graphVersion: input.graph.graphVersion,
    sessionId: input.graph.sessionId,
    architectureId: input.graph.architectureId,
    approval: input.graph.approval,
    ...(input.runId ? { runId: input.runId } : {}),
    nodes,
    edges: input.graph.tasks.flatMap((task) => task.dependsOn.map((dependency) => ({
      fromTaskId: dependency,
      toTaskId: task.id,
    }))),
  };
}

export function isTaskGraphProjectionConsistent(
  projection: TaskGraphProjection,
): boolean {
  return projection.nodes.every((node) => node.consistency === 'consistent');
}

export function taskGraphProjectionTask(
  projection: TaskGraphProjection,
  taskId: string,
): TaskGraphProjectionNode | undefined {
  return projection.nodes.find((node) => node.taskId === taskId);
}

export function taskGraphProjectionHasTask(
  projection: TaskGraphProjection,
  taskId: string,
): boolean {
  return taskById(projection, taskId) !== undefined;
}

function taskById(
  projection: TaskGraphProjection,
  taskId: string,
): TaskGraphProjectionNode | undefined {
  return projection.nodes.find((node) => node.taskId === taskId);
}
