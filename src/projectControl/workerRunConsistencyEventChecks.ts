import { replayDomainEvents, type DomainEvent, type DomainProjection } from '../domain/contracts';
import type { EvidenceRecord } from '../dev/evidence';
import type {
  WorkerRunConsistencyAuditContext,
  WorkerRunConsistencyInput,
  WorkerRunConsistencyIssue,
} from './workerRunConsistencyTypes';
import { issue } from './workerRunConsistencyUtils';

export function checkInitialConsistencyFacts(
  input: WorkerRunConsistencyInput,
  issues: WorkerRunConsistencyIssue[],
): DomainEvent[] {
  if (input.runs.length > 0 && input.evidence === undefined) {
    issues.push(issue('evidence-lineage-drift', 'Worker Evidence 尚未加载，拒绝在不完整事实上通过审计'));
  }
  if (
    input.runs.some((run) => Object.values(run.tasks).some((task) => !!task.acceptanceId))
    && input.acceptances === undefined
  ) {
    issues.push(issue('acceptance-lineage-drift', 'Worker Acceptance 尚未加载，拒绝在不完整事实上通过审计'));
  }
  const projectEvents = input.events.filter((event) => event.streamId === input.projectId);
  if (projectEvents.length !== input.events.length) {
    issues.push(issue(
      'event-stream-project-mismatch',
      '事件流包含不属于当前项目的 Worker 事实，拒绝静默混合',
    ));
  }
  return projectEvents;
}

export function replayWorkerEvents(
  projectEvents: readonly DomainEvent[],
  issues: WorkerRunConsistencyIssue[],
): DomainProjection | undefined {
  try {
    return replayDomainEvents(projectEvents);
  } catch (cause) {
    issues.push(issue(
      'invalid-event-stream',
      `Worker 事件流无法重放：${cause instanceof Error ? cause.message : String(cause)}`,
    ));
    return undefined;
  }
}

export function createWorkerRunAuditContext(
  input: WorkerRunConsistencyInput,
  projection: DomainProjection,
  issues: WorkerRunConsistencyIssue[],
): WorkerRunConsistencyAuditContext {
  const evidenceById = new Map<string, EvidenceRecord>();
  for (const record of input.evidence ?? []) {
    if (evidenceById.has(record.id)) {
      issues.push(issue(
        'evidence-lineage-drift',
        `Evidence id 重复，拒绝静默覆盖：${record.id}`,
        { runId: record.runId, taskId: record.taskId },
      ));
      continue;
    }
    evidenceById.set(record.id, record);
  }
  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const graphIds = new Set<string>();
  const duplicateGraphIds = new Set<string>();
  for (const graph of input.taskGraphs ?? []) {
    if (graphIds.has(graph.id)) duplicateGraphIds.add(graph.id);
    graphIds.add(graph.id);
  }
  return { input, projection, issues, evidenceById, runsById, duplicateGraphIds };
}
