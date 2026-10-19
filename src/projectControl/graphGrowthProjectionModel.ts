import { createTaskExecutionId } from '../domain/execution';
import {
  type AttemptRecord,
  type DomainEvent,
  type DomainProjection,
  type TaskExecutionProjection,
  type TaskProjectionStatus,
} from '../domain/contracts';
import { buildManagerBrief, type ProgressSummary } from './progressSummary';
import type { ProjectTask, ProjectTaskGraph, ProjectTaskStatus } from './types';
import type { TaskGraphProjection, TaskGraphProjectionNode } from './taskGraphProjection';

export type GraphGrowthNodeKind = 'session' | 'module' | 'task' | 'attempt';
export type GraphGrowthStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting-feedback'
  | 'blocked'
  | 'succeeded'
  | 'unverified'
  | 'failed'
  | 'unknown'
  | 'cancelled';
export type GraphGrowthEdgeKind = 'hierarchy' | 'dependency';
export type GraphGrowthOutcome = 'succeeded' | 'failed' | 'unknown' | 'cancelled';

export interface GraphGrowthNode {
  id: string;
  kind: GraphGrowthNodeKind;
  label: string;
  status: GraphGrowthStatus;
  sessionId: string;
  graphId?: string;
  moduleId?: string;
  taskId?: string;
  attemptId?: string;
  attempt?: number;
  parentId?: string;
  eventIds: readonly string[];
  evidenceIds: readonly string[];
  acceptanceId?: string;
  error?: string;
  leaseHeld: boolean;
  pulse: boolean;
  scar: boolean;
}

export interface GraphGrowthEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: GraphGrowthEdgeKind;
  eventIds: readonly string[];
  flowCount: number;
}

export interface GraphGrowthFlow {
  scope: 'task' | 'module';
  taskId?: string;
  moduleId: string;
  count: number;
  eventIds: readonly string[];
}

export interface GraphGrowthRing {
  id: string;
  taskId: string;
  attemptId: string;
  outcome: GraphGrowthOutcome;
  eventId: string;
}

export interface GraphGrowthMarker {
  id: string;
  eventId: string;
  eventType: string;
  sequence: number;
  occurredAt: string;
  actor: DomainEvent['actor'];
  kind: 'decision' | 'failure' | 'unknown' | 'user-intervention' | 'work-package' | 'feedback';
}

export interface GraphGrowthCapsule {
  id: string;
  moduleId: string;
  graphId: string;
  taskIds: readonly string[];
  completionBasis: ProgressSummary['completionBasis'];
  evidenceRefs: readonly string[];
  acceptanceRefs: readonly string[];
  sourceVersion: number;
  eventIds: readonly string[];
}

export interface GraphGrowthProjection {
  uptoSeq: number;
  lastSequence: number;
  nodes: readonly GraphGrowthNode[];
  edges: readonly GraphGrowthEdge[];
  flow: readonly GraphGrowthFlow[];
  scars: readonly string[];
  rings: readonly GraphGrowthRing[];
  capsules: readonly GraphGrowthCapsule[];
  markers: readonly GraphGrowthMarker[];
  legacyGraphIds: readonly string[];
}

interface EventLineage {
  taskId: string;
  taskExecutionId: string;
  graphId?: string;
  attemptId?: string;
}

export const TASK_EVENT_TYPES = new Set([
  'TaskQueued',
  'TaskStarted',
  'TaskFeedbackRequested',
  'TaskSucceeded',
  'TaskFailed',
  'TaskBlocked',
  'TaskCancelled',
  'TaskAttemptMarkedUnknown',
  'TaskAttemptImported',
  'TaskCleaned',
]);

export const TASK_GRAPH_SNAPSHOT_EVENT_TYPES = new Set([
  'TaskGraphProposed',
  'TaskGraphRevisionCreated',
  'TaskGraphApproved',
  'TaskGraphSuperseded',
]);

const DECISION_EVENT_TYPES = new Set([
  'ArchitectureApproved',
  'ProjectPlanApproved',
  'TaskGraphApproved',
  'WorkerRunRecoveryDecided',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function payloadOf(event: DomainEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

export function graphFromEvent(event: DomainEvent): ProjectTaskGraph | undefined {
  const graph = payloadOf(event).graph;
  if (!isRecord(graph) || typeof graph.id !== 'string' || !Array.isArray(graph.tasks)) return undefined;
  return graph as unknown as ProjectTaskGraph;
}

export function eventLineage(event: DomainEvent): EventLineage | undefined {
  const payload = payloadOf(event);
  const taskId = text(payload, 'taskId')
    ?? (event.aggregateType === 'Task' ? event.aggregateId : undefined);
  const runId = text(payload, 'runId');
  if (!taskId || !runId) return undefined;
  const taskExecutionId = text(payload, 'taskExecutionId')
    ?? (event.aggregateType === 'TaskExecution'
      ? event.aggregateId
      : createTaskExecutionId(runId, taskId));
  return {
    taskId,
    taskExecutionId,
    ...(event.source?.objectId ? { graphId: event.source.objectId } : {}),
    ...(text(payload, 'attemptId') ? { attemptId: text(payload, 'attemptId') } : {}),
  };
}

export function statusFromTask(status: ProjectTaskStatus): GraphGrowthStatus {
  switch (status) {
    case 'proposed':
    case 'approved': return 'idle';
    case 'queued': return 'queued';
    case 'in_progress': return 'running';
    case 'review': return 'waiting-feedback';
    case 'blocked': return 'blocked';
    case 'done': return 'unverified';
    case 'cancelled': return 'cancelled';
  }
}

export function statusFromExecution(status: TaskProjectionStatus): GraphGrowthStatus {
  switch (status) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'waiting-feedback': return 'waiting-feedback';
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'cancelled': return 'cancelled';
  }
}

export function statusFromAttempt(status: AttemptRecord['status']): GraphGrowthStatus {
  return status === 'unknown' ? 'unknown' : statusFromExecution(status);
}

function projectedIssueStatus(status: GraphGrowthStatus): TaskGraphProjectionNode['projectedStatus'] {
  switch (status) {
    case 'idle': return 'approved';
    case 'queued': return 'queued';
    case 'running': return 'in_progress';
    case 'waiting-feedback':
    case 'blocked':
    case 'failed':
    case 'unknown':
    case 'unverified': return 'blocked';
    case 'succeeded': return 'done';
    case 'cancelled': return 'cancelled';
  }
}

export function attemptOutcome(status: AttemptRecord['status']): GraphGrowthOutcome | undefined {
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'unknown') {
    return status;
  }
  return undefined;
}

export function eventMarker(event: DomainEvent): GraphGrowthMarker | undefined {
  let kind: GraphGrowthMarker['kind'] | undefined;
  if (event.eventType === 'DepartmentWorkPackageDispatched') kind = 'work-package';
  else if (event.eventType === 'TaskFailed') kind = 'failure';
  else if (event.eventType === 'TaskAttemptMarkedUnknown') kind = 'unknown';
  else if (event.eventType === 'TaskFeedbackRequested') kind = 'feedback';
  else if (DECISION_EVENT_TYPES.has(event.eventType)) kind = 'decision';
  else if (event.actor === 'user' && TASK_GRAPH_SNAPSHOT_EVENT_TYPES.has(event.eventType)) kind = 'user-intervention';
  if (!kind) return undefined;
  return {
    id: `marker:${event.eventId}`,
    eventId: event.eventId,
    eventType: event.eventType,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actor: event.actor,
    kind,
  };
}

export function aggregateStatus(statuses: readonly GraphGrowthStatus[]): GraphGrowthStatus {
  if (statuses.length === 0 || statuses.every((status) => status === 'idle')) return 'idle';
  if (statuses.every((status) => status === 'succeeded')) return 'succeeded';
  if (statuses.some((status) => status === 'waiting-feedback')) return 'waiting-feedback';
  if (statuses.some((status) => status === 'blocked' || status === 'unknown')) return 'blocked';
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'queued')) return 'queued';
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled';
  return 'unverified';
}

export function executionsForTask(
  projection: DomainProjection,
  taskId: string,
  graphId: string,
  executionGraphIds: ReadonlyMap<string, string>,
  latestSequence: ReadonlyMap<string, number>,
): TaskExecutionProjection[] {
  return Object.values(projection.taskExecutions)
    .filter((execution) => execution.taskId === taskId
      && executionGraphIds.get(execution.taskExecutionId) === graphId)
    .sort((left, right) => (latestSequence.get(left.taskExecutionId) ?? 0)
      - (latestSequence.get(right.taskExecutionId) ?? 0));
}

export function makeCapsule(
  graph: ProjectTaskGraph,
  moduleId: string,
  moduleTasks: readonly ProjectTask[],
  taskNodes: ReadonlyMap<string, GraphGrowthNode>,
  sequence: number,
  occurredAt: string,
): GraphGrowthCapsule | undefined {
  const projectedNodes: TaskGraphProjectionNode[] = moduleTasks.map((task) => {
    const node = taskNodes.get(`${graph.id}\u0000${task.id}`)!;
    return {
      graphId: graph.id,
      taskId: task.id,
      issueId: `capsule-task:${graph.id}:${task.id}`,
      title: task.title,
      description: task.description,
      taskStatus: task.status,
      projectedStatus: projectedIssueStatus(node.status),
      dependsOn: [...task.dependsOn],
      evidenceIds: [...node.evidenceIds],
      ...(node.acceptanceId ? { acceptanceId: node.acceptanceId } : {}),
      ...(node.error ? { error: node.error } : {}),
      consistency: node.status === 'unknown' || node.status === 'unverified'
        ? 'execution-lineage-drift'
        : 'consistent',
    };
  });
  const projection: TaskGraphProjection = {
    graphId: graph.id,
    graphVersion: graph.graphVersion,
    sessionId: graph.sessionId,
    architectureId: graph.architectureId,
    approval: graph.approval,
    nodes: projectedNodes,
    edges: [],
  };
  const summary = buildManagerBrief({
    projection,
    summaryId: `capsule:${graph.id}:${moduleId}:${sequence}`,
    sourceVersion: Math.max(1, sequence),
    now: occurredAt || graph.updatedAt,
    // No TTL policy exists in A1. The capsule consumes completionBasis only.
    staleAt: occurredAt || graph.updatedAt,
  });
  if (summary.completionBasis !== 'evidence-backed') return undefined;
  const eventIds = unique(moduleTasks.flatMap((task) => (
    taskNodes.get(`${graph.id}\u0000${task.id}`)?.eventIds ?? []
  )));
  return {
    id: `capsule:${graph.id}:${moduleId}`,
    moduleId,
    graphId: graph.id,
    taskIds: moduleTasks.map((task) => task.id),
    completionBasis: summary.completionBasis,
    evidenceRefs: summary.evidenceRefs,
    acceptanceRefs: summary.acceptanceRefs,
    sourceVersion: summary.sourceVersion,
    eventIds,
  };
}
