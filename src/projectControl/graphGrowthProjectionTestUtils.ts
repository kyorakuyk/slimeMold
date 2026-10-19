import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { DomainEvent } from '../domain/contracts';
import type { ProjectTask, ProjectTaskGraph } from './types';
import { graphGrowthProjection } from './graphGrowthProjection';

export const PROJECT_ID = 'project-live-graph';
export const SESSION_ID = 'session-live-graph';
export const GRAPH_ID = 'graph-live-graph';
export const RUN_ID = 'run-live-graph';

export function task(id: string, moduleId: string, dependsOn: string[] = []): ProjectTask {
  return {
    version: 1,
    id,
    architectureId: 'architecture-live-graph',
    title: `Title ${id}`,
    description: `Description ${id}`,
    moduleId,
    scope: [`src/${id}.ts`],
    dependsOn,
    acceptanceCriteria: [`acceptance ${id}`],
    category: 'logic',
    status: 'approved',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

export function graph(
  id = GRAPH_ID,
  tasks: ProjectTask[] = [task('task-a', 'core')],
  graphVersion = 1,
): ProjectTaskGraph {
  return {
    version: 1,
    id,
    sessionId: SESSION_ID,
    architectureId: 'architecture-live-graph',
    graphVersion,
    tasks,
    approval: 'approved',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

export function eventStream() {
  const events: DomainEvent[] = [];
  const aggregateVersions = new Map<string, number>();
  const append = (
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    options: {
      actor?: DomainEvent['actor'];
      sourceId?: string;
      sourceVersion?: number;
      correlationId?: string;
      synthetic?: boolean;
    } = {},
  ): DomainEvent => {
    const aggregateKey = `${aggregateType}\u0000${aggregateId}`;
    const aggregateVersion = (aggregateVersions.get(aggregateKey) ?? 0) + 1;
    aggregateVersions.set(aggregateKey, aggregateVersion);
    const sequence = events.length + 1;
    const event: DomainEvent = {
      eventId: `event-${sequence}-${eventType}`,
      streamId: PROJECT_ID,
      sequence,
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventType,
      schemaVersion: 1,
      payload,
      actor: options.actor ?? 'runtime',
      occurredAt: `2026-10-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(options.sourceId ? {
        source: { objectId: options.sourceId, objectVersion: options.sourceVersion ?? 1 },
      } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.synthetic ? { synthetic: options.synthetic } : {}),
    };
    events.push(event);
    return event;
  };
  const addGraph = (value: ProjectTaskGraph, eventType = 'TaskGraphProposed'): DomainEvent => append(
    eventType,
    'TaskGraph',
    value.id,
    {
      taskGraphId: value.id,
      sessionId: value.sessionId,
      architectureId: value.architectureId,
      graphVersion: value.graphVersion,
      taskIds: value.tasks.map((item) => item.id),
      graph: value,
    },
    { actor: 'master', sourceId: value.id, sourceVersion: value.graphVersion },
  );
  const addQueued = (taskId: string, nextAttempt?: number, runId = RUN_ID): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(runId, taskId);
    return append(
      'TaskQueued',
      'TaskExecution',
      taskExecutionId,
      {
        runId,
        taskId,
        taskExecutionId,
        taskGraphId: GRAPH_ID,
        ...(nextAttempt ? { nextAttempt } : {}),
      },
      { sourceId: GRAPH_ID },
    );
  };
  const addStarted = (taskId: string, attempt = 1, runId = RUN_ID, withLease = true): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(runId, taskId);
    const attemptId = createAttemptId(taskExecutionId, attempt);
    return append(
      'TaskStarted',
      'TaskExecution',
      taskExecutionId,
      {
        runId,
        taskId,
        taskExecutionId,
        attemptId,
        attempt,
        ...(withLease ? {
          worktreeId: `worktree-${taskId}-${attempt}`,
          worktreePath: `C:/worktrees/${taskId}-${attempt}`,
          branch: `worker/${taskId}-${attempt}`,
          baseRevision: 'base-revision',
          worktreeStatus: 'created',
        } : {}),
      },
      { sourceId: GRAPH_ID },
    );
  };
  const addSucceeded = (taskId: string, attempt = 1, runId = RUN_ID): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(runId, taskId);
    return append(
      'TaskSucceeded',
      'TaskExecution',
      taskExecutionId,
      {
        runId,
        taskId,
        taskExecutionId,
        attemptId: createAttemptId(taskExecutionId, attempt),
        attempt,
        evidenceIds: [`evidence-${taskId}-${attempt}`],
        acceptanceId: `acceptance-${taskId}-${attempt}`,
      },
      { sourceId: GRAPH_ID },
    );
  };
  const addFailed = (taskId: string, attempt = 1, runId = RUN_ID): DomainEvent => {
    const taskExecutionId = createTaskExecutionId(runId, taskId);
    return append(
      'TaskFailed',
      'TaskExecution',
      taskExecutionId,
      {
        runId,
        taskId,
        taskExecutionId,
        attemptId: createAttemptId(taskExecutionId, attempt),
        attempt,
        error: `failure-${taskId}-${runId}-${attempt}`,
      },
      { sourceId: GRAPH_ID },
    );
  };
  return { events, append, addGraph, addQueued, addStarted, addSucceeded, addFailed };
}

export function nodeForTask(
  projection: ReturnType<typeof graphGrowthProjection>,
  taskId: string,
) {
  return projection.nodes.find((node) => node.kind === 'task' && node.taskId === taskId);
}

export function nodeForAttempt(
  projection: ReturnType<typeof graphGrowthProjection>,
  attemptId: string,
) {
  return projection.nodes.find((node) => node.kind === 'attempt' && node.attemptId === attemptId);
}
