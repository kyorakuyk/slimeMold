import { appendDomainEvent, type DomainEvent } from '../domain/contracts';
import { triageTaskGraph } from './triage';
import type { ProjectControlSnapshot } from './types';
import {
  WORK_ORDER_PREFLIGHT_COMPLETED_EVENT,
  parsePreflightResponse,
  workOrderDigest,
  type WorkOrderPreflightCompletedPayload,
  type WorkOrderPreflightCost,
} from './workOrderPreflight';

export interface RecordWorkOrderPreflightCommandInput {
  snapshot: ProjectControlSnapshot;
  preflightId: string;
  taskGraphId: string;
  taskId: string;
  graphVersion: number;
  workOrderText: string;
  rawResponse: string;
  model: string;
  cost: WorkOrderPreflightCost;
  now: string;
}

export interface WorkOrderPreflightCommandResult {
  snapshot: ProjectControlSnapshot;
  events: DomainEvent[];
}

function requiredIdentity(value: string, field: string): string {
  if (!value || value.trim() !== value) throw new Error(`${field} 必须是非空 canonical 字符串`);
  return value;
}

function validateCost(cost: WorkOrderPreflightCost): WorkOrderPreflightCost {
  if (cost.status === 'not-metered') return cost;
  if (cost.status === 'metered' && Number.isFinite(cost.amountUsd) && cost.amountUsd >= 0) return cost;
  throw new Error('试读 cost 必须是 not-metered 或非负的实测 USD 金额');
}

/** Record one shadow-only preflight fact; it never edits the graph or approval. */
export function recordWorkOrderPreflightCommand(
  input: RecordWorkOrderPreflightCommandInput,
): WorkOrderPreflightCommandResult {
  const preflightId = requiredIdentity(input.preflightId, 'preflightId');
  const taskGraphId = requiredIdentity(input.taskGraphId, 'taskGraphId');
  const taskId = requiredIdentity(input.taskId, 'taskId');
  const model = requiredIdentity(input.model, 'model');
  const now = requiredIdentity(input.now, 'now');
  if (!Number.isSafeInteger(input.graphVersion) || input.graphVersion < 1) {
    throw new Error('graphVersion 必须是正整数');
  }
  if (!input.workOrderText.trim()) throw new Error('workOrderText 不能为空');

  const graph = input.snapshot.taskGraphs?.find((item) => item.id === taskGraphId);
  if (!graph || graph.graphVersion !== input.graphVersion) {
    throw new Error(`task graph 不存在或版本已过期：${taskGraphId}@${input.graphVersion}`);
  }
  if (!graph.tasks.some((task) => task.id === taskId)) {
    throw new Error(`task 不属于当前 task graph：${taskId}`);
  }
  if (triageTaskGraph(graph).level === 'L0') {
    throw new Error(`L0 直通任务不需要 B1 试读：${taskId}`);
  }
  const session = input.snapshot.sessions.find((item) => item.id === graph.sessionId);
  if (!session) throw new Error(`task graph session 不存在：${graph.sessionId}`);

  const assessment = parsePreflightResponse(input.rawResponse, input.workOrderText);
  const payload: WorkOrderPreflightCompletedPayload = {
    preflightId,
    taskGraphId,
    taskId,
    graphVersion: graph.graphVersion,
    workOrderDigest: workOrderDigest(input.workOrderText),
    model,
    verdict: assessment.verdict,
    guessPoints: assessment.guessPoints,
    droppedCount: assessment.droppedCount,
    cost: validateCost(input.cost),
    mode: 'shadow',
    createdAt: now,
  };
  const event: DomainEvent<WorkOrderPreflightCompletedPayload> = {
    eventId: `${preflightId}:completed`,
    streamId: session.projectId,
    sequence: 1,
    aggregateType: 'TaskGraph',
    aggregateId: graph.id,
    aggregateVersion: 1,
    eventType: WORK_ORDER_PREFLIGHT_COMPLETED_EVENT,
    schemaVersion: 1,
    payload,
    actor: 'master',
    occurredAt: now,
    correlationId: session.id,
    source: { objectId: graph.id, objectVersion: graph.graphVersion },
    sensitivity: 'private',
  };
  return {
    snapshot: input.snapshot,
    events: appendDomainEvent([], event),
  };
}
