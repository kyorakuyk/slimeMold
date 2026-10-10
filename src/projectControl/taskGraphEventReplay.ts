import type { DomainEvent } from '../domain/contracts';
import type { ProjectTask, ProjectTaskGraph } from './types';

const TASK_GRAPH_EVENT_TYPES = new Set([
  'TaskGraphProposed',
  'TaskGraphRevisionCreated',
  'TaskGraphApproved',
  'TaskGraphSuperseded',
  'LegacyTaskGraphImported',
]);

const TASK_STATUSES = new Set([
  'proposed',
  'approved',
  'queued',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalText(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || record[key] === undefined || typeof record[key] === 'string';
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProjectTask(value: unknown): value is ProjectTask {
  if (!isRecord(value)) return false;
  return value.version === 1
    && isText(value.id)
    && isText(value.architectureId)
    && isText(value.title)
    && typeof value.description === 'string'
    && isText(value.moduleId)
    && isTextArray(value.scope)
    && isTextArray(value.dependsOn)
    && isTextArray(value.acceptanceCriteria)
    && isText(value.category)
    && typeof value.status === 'string'
    && TASK_STATUSES.has(value.status)
    && isText(value.createdAt)
    && isText(value.updatedAt)
    && isOptionalText(value, 'issueId')
    && isOptionalText(value, 'workflowId')
    && isOptionalText(value, 'stageId');
}

function isProjectTaskGraph(value: unknown): value is ProjectTaskGraph {
  if (!isRecord(value)) return false;
  return value.version === 1
    && isText(value.id)
    && isText(value.sessionId)
    && isText(value.architectureId)
    && typeof value.graphVersion === 'number'
    && Number.isSafeInteger(value.graphVersion)
    && value.graphVersion > 0
    && Array.isArray(value.tasks)
    && value.tasks.every(isProjectTask)
    && (value.approval === 'draft' || value.approval === 'approved' || value.approval === 'superseded')
    && isText(value.createdAt)
    && isText(value.updatedAt)
    && isOptionalText(value, 'approvedBy')
    && isOptionalText(value, 'approvedAt')
    && isOptionalText(value, 'revisionOf')
    && isOptionalText(value, 'supersededBy');
}

function payloadFor(event: DomainEvent): Record<string, unknown> | undefined {
  return isRecord(event.payload) ? event.payload : undefined;
}

function graphIdFor(event: DomainEvent, payload: Record<string, unknown>): string | undefined {
  if (event.aggregateType !== 'TaskGraph') return undefined;
  if (isText(event.aggregateId)) return event.aggregateId;
  if (isText(payload.taskGraphId)) return payload.taskGraphId;
  if (isText(payload.id)) return payload.id;
  return undefined;
}

function graphSnapshotFor(
  graphId: string,
  payload: Record<string, unknown>,
): ProjectTaskGraph | undefined {
  const payloadId = isText(payload.taskGraphId)
    ? payload.taskGraphId
    : isText(payload.id)
      ? payload.id
      : undefined;
  if (payloadId && payloadId !== graphId) return undefined;
  const graph = payload.graph;
  if (!isProjectTaskGraph(graph) || graph.id !== graphId) return undefined;
  return graph;
}

/** Rebuild only task-graph snapshots explicitly carried by durable events. */
export function replayTaskGraphsFromEvents(events: readonly DomainEvent[]): {
  graphs: ProjectTaskGraph[];
  legacyGraphIds: string[];
} {
  const snapshots = new Map<string, ProjectTaskGraph>();
  const firstSeen = new Map<string, number>();
  const legacyGraphIds = new Set<string>();
  const seenEventIds = new Set<string>();

  for (const event of events) {
    if (seenEventIds.has(event.eventId)) continue;
    seenEventIds.add(event.eventId);
    if (!TASK_GRAPH_EVENT_TYPES.has(event.eventType)) continue;

    const payload = payloadFor(event);
    if (!payload) continue;
    const graphId = graphIdFor(event, payload);
    if (!graphId) continue;
    if (!firstSeen.has(graphId)) firstSeen.set(graphId, firstSeen.size);

    const graph = graphSnapshotFor(graphId, payload);
    if (graph) {
      snapshots.set(graphId, graph);
      legacyGraphIds.delete(graphId);
    } else {
      snapshots.delete(graphId);
      legacyGraphIds.add(graphId);
    }
  }

  const byFirstAppearance = (left: string, right: string): number =>
    (firstSeen.get(left) ?? Number.MAX_SAFE_INTEGER) - (firstSeen.get(right) ?? Number.MAX_SAFE_INTEGER);

  return {
    graphs: [...snapshots.entries()]
      .sort(([left], [right]) => byFirstAppearance(left, right))
      .map(([, graph]) => graph),
    legacyGraphIds: [...legacyGraphIds].sort(byFirstAppearance),
  };
}
