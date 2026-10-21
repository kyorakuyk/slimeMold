import { replayDomainEvents, type DomainEvent, type AttemptRecord } from '../domain/contracts';
import { hasWorkerSuccessProvenance } from '../domain/workerSuccess';
import { replayTaskGraphsFromEvents } from './taskGraphEventReplay';
import type { ProjectTask, ProjectTaskGraph } from './types';
import {
  aggregateStatus,
  attemptOutcome,
  eventLineage,
  eventMarker,
  graphFromEvent,
  executionsForTask,
  makeCapsule,
  payloadOf,
  statusFromAttempt,
  statusFromExecution,
  statusFromTask,
  TASK_EVENT_TYPES,
  TASK_GRAPH_SNAPSHOT_EVENT_TYPES,
  text,
  unique,
  type GraphGrowthCapsule,
  type GraphGrowthEdge,
  type GraphGrowthFlow,
  type GraphGrowthMarker,
  type GraphGrowthNode,
  type GraphGrowthProjection,
  type GraphGrowthRing,
} from './graphGrowthProjectionModel';

/** Rebuild the read-only living graph from one event-stream prefix. */
export function graphGrowthProjection(
  events: readonly DomainEvent[],
  uptoSeq: number,
): GraphGrowthProjection {
  if (!Number.isSafeInteger(uptoSeq) || uptoSeq < 0) {
    throw new Error('uptoSeq 必须是非负安全整数');
  }
  const visibleEvents = events.filter((event) => event.sequence <= uptoSeq);
  const replayedGraphs = replayTaskGraphsFromEvents(visibleEvents);
  const graphById = new Map(replayedGraphs.graphs.map((graph) => [graph.id, graph]));
  const activeBySession = new Map<string, string>();
  const graphEventIds = new Map<string, string[]>();
  const sessionEventIds = new Map<string, string[]>();

  for (const event of visibleEvents) {
    const payload = payloadOf(event);
    if (event.eventType === 'SessionTaskGraphLinked') {
      const sessionId = text(payload, 'sessionId');
      const taskGraphId = text(payload, 'taskGraphId');
      if (sessionId && taskGraphId) {
        activeBySession.set(sessionId, taskGraphId);
        const ids = sessionEventIds.get(sessionId) ?? [];
        ids.push(event.eventId);
        sessionEventIds.set(sessionId, ids);
      }
    }
    if (!TASK_GRAPH_SNAPSHOT_EVENT_TYPES.has(event.eventType)) continue;
    const eventGraph = graphFromEvent(event);
    const graph = eventGraph ? graphById.get(eventGraph.id) : undefined;
    if (!graph) continue;
    const ids = graphEventIds.get(graph.id) ?? [];
    ids.push(event.eventId);
    graphEventIds.set(graph.id, ids);
    if (event.eventType === 'TaskGraphSuperseded'
      && activeBySession.get(graph.sessionId) === graph.id) {
      activeBySession.delete(graph.sessionId);
    } else if (event.eventType === 'TaskGraphProposed'
      || event.eventType === 'TaskGraphRevisionCreated') {
      activeBySession.set(graph.sessionId, graph.id);
    }
  }

  const activeGraphs = unique([...activeBySession.values()])
    .map((graphId) => graphById.get(graphId))
    .filter((graph): graph is ProjectTaskGraph => !!graph);
  const activeGraphIds = new Set(activeGraphs.map((graph) => graph.id));
  const activeGraphsByTask = new Map<string, string[]>();
  for (const graph of activeGraphs) {
    for (const task of graph.tasks) {
      const ids = activeGraphsByTask.get(task.id) ?? [];
      ids.push(graph.id);
      activeGraphsByTask.set(task.id, ids);
    }
  }

  const executionGraphIds = new Map<string, string>();
  const executionEventIds = new Map<string, string[]>();
  const executionLatestSequence = new Map<string, number>();
  const attemptEventIds = new Map<string, string[]>();
  const attemptStartedAt = new Map<string, { sequence: number; eventId: string }>();
  const attemptTerminalEvent = new Map<string, string>();
  const attemptTerminalSequence = new Map<string, number>();
  const successEventsByTask = new Map<string, DomainEvent[]>();
  const markers: GraphGrowthMarker[] = [];

  for (const event of visibleEvents) {
    const marker = eventMarker(event);
    if (marker) markers.push(marker);
    if (!TASK_EVENT_TYPES.has(event.eventType)) continue;
    const lineage = eventLineage(event);
    if (!lineage) continue;
    const candidateGraphId = lineage.graphId
      ?? text(payloadOf(event), 'taskGraphId')
      ?? (activeGraphsByTask.get(lineage.taskId)?.length === 1
        ? activeGraphsByTask.get(lineage.taskId)?.[0]
        : undefined);
    if (!candidateGraphId || !activeGraphIds.has(candidateGraphId)) continue;
    executionGraphIds.set(lineage.taskExecutionId, candidateGraphId);
    const ids = executionEventIds.get(lineage.taskExecutionId) ?? [];
    ids.push(event.eventId);
    executionEventIds.set(lineage.taskExecutionId, ids);
    executionLatestSequence.set(lineage.taskExecutionId, event.sequence);
    if (lineage.attemptId) {
      const attemptIds = attemptEventIds.get(lineage.attemptId) ?? [];
      attemptIds.push(event.eventId);
      attemptEventIds.set(lineage.attemptId, attemptIds);
      if (event.eventType === 'TaskStarted' && !attemptStartedAt.has(lineage.attemptId)) {
        attemptStartedAt.set(lineage.attemptId, { sequence: event.sequence, eventId: event.eventId });
      }
      if (event.eventType === 'TaskSucceeded'
        || event.eventType === 'TaskFailed'
        || event.eventType === 'TaskCancelled'
        || event.eventType === 'TaskAttemptMarkedUnknown') {
        attemptTerminalEvent.set(lineage.attemptId, event.eventId);
        attemptTerminalSequence.set(lineage.attemptId, event.sequence);
      }
    }
    if (event.eventType === 'TaskSucceeded'
      && hasWorkerSuccessProvenance(payloadOf(event) as { evidenceIds?: string[]; acceptanceId?: string })) {
      const key = `${candidateGraphId}\u0000${lineage.taskId}`;
      const successes = successEventsByTask.get(key) ?? [];
      successes.push(event);
      successEventsByTask.set(key, successes);
    }
  }

  const execution = replayDomainEvents(visibleEvents);
  const nodes: GraphGrowthNode[] = [];
  const edges: GraphGrowthEdge[] = [];
  const flow: GraphGrowthFlow[] = [];
  const scars: string[] = [];
  const rings: GraphGrowthRing[] = [];
  const capsules: GraphGrowthCapsule[] = [];
  const taskNodeByGraphTask = new Map<string, GraphGrowthNode>();

  for (const graph of activeGraphs) {
    const graphIds = unique(graphEventIds.get(graph.id) ?? []);
    const sessionId = graph.sessionId;
    const sessionNodeId = `session:${sessionId}`;
    const sessionIds = sessionEventIds.get(sessionId) ?? [];
    sessionIds.push(...graphIds);
    sessionEventIds.set(sessionId, sessionIds);
    const moduleTasks = new Map<string, ProjectTask[]>();
    for (const task of graph.tasks) {
      const tasks = moduleTasks.get(task.moduleId) ?? [];
      tasks.push(task);
      moduleTasks.set(task.moduleId, tasks);
    }

    const moduleNodeById = new Map<string, GraphGrowthNode>();
    for (const [moduleId, tasks] of moduleTasks) {
      const moduleNode: GraphGrowthNode = {
        id: `module:${sessionId}:${moduleId}`,
        kind: 'module',
        label: moduleId,
        status: 'idle',
        sessionId,
        graphId: graph.id,
        moduleId,
        parentId: sessionNodeId,
        eventIds: graphIds,
        evidenceIds: [],
        leaseHeld: false,
        pulse: false,
        scar: false,
      };
      moduleNodeById.set(moduleId, moduleNode);
      nodes.push(moduleNode);
      edges.push({
        id: `contains:${sessionNodeId}:${moduleNode.id}`,
        sourceId: sessionNodeId,
        targetId: moduleNode.id,
        kind: 'hierarchy',
        eventIds: graphIds,
        flowCount: 0,
      });

      for (const task of tasks) {
        const taskNodeId = `task:${graph.id}:${task.id}`;
        const taskExecutions = executionsForTask(
          execution,
          task.id,
          graph.id,
          executionGraphIds,
          executionLatestSequence,
        );
        const selected = taskExecutions.at(-1);
        const taskAttempts = taskExecutions.flatMap((item) => item.attemptIds
          .map((attemptId) => execution.attempts[attemptId])
          .filter((attempt): attempt is AttemptRecord => !!attempt));
        const selectedAttempts = selected?.attemptIds
          .map((attemptId) => execution.attempts[attemptId])
          .filter((attempt): attempt is AttemptRecord => !!attempt) ?? [];
        const latestAttempt = selected?.currentAttemptId
          ? execution.attempts[selected.currentAttemptId]
          : [...selectedAttempts].sort((left, right) => right.attempt - left.attempt)[0];
        let status = selected ? statusFromExecution(selected.status) : statusFromTask(task.status);
        if (selected?.status === 'succeeded' && !hasWorkerSuccessProvenance(selected)) status = 'unverified';
        if (selected?.status === 'running' && !selected.currentAttemptId && latestAttempt?.status === 'unknown') {
          status = 'unknown';
        }
        const leaseHeld = status === 'running'
          && !!latestAttempt?.worktreeId
          && !!latestAttempt.worktreePath
          && !!latestAttempt.branch
          && !!latestAttempt.baseRevision;
        const taskEventIds = taskExecutions.flatMap((item) => executionEventIds.get(item.taskExecutionId) ?? []);
        const taskNode: GraphGrowthNode = {
          id: taskNodeId,
          kind: 'task',
          label: task.title,
          status,
          sessionId,
          graphId: graph.id,
          moduleId: task.moduleId,
          taskId: task.id,
          parentId: moduleNode.id,
          eventIds: unique([...graphIds, ...taskEventIds]),
          evidenceIds: selected?.evidenceIds ?? [],
          ...(selected?.acceptanceId ? { acceptanceId: selected.acceptanceId } : {}),
          ...(selected?.error ? { error: selected.error } : {}),
          leaseHeld,
          pulse: leaseHeld,
          scar: false,
        };
        taskNodeByGraphTask.set(`${graph.id}\u0000${task.id}`, taskNode);
        nodes.push(taskNode);
        edges.push({
          id: `contains:${moduleNode.id}:${taskNode.id}`,
          sourceId: moduleNode.id,
          targetId: taskNode.id,
          kind: 'hierarchy',
          eventIds: graphIds,
          flowCount: 0,
        });

        for (const item of taskAttempts) {
          const attemptNodeId = `attempt:${item.attemptId}`;
          const failedAt = attemptTerminalSequence.get(item.attemptId);
          const scarTrigger = item.status === 'failed' && failedAt !== undefined
            ? taskAttempts.map((later) => attemptStartedAt.get(later.attemptId))
              .filter((start) => start && start.sequence > failedAt)
              .sort((left, right) => (left?.sequence ?? 0) - (right?.sequence ?? 0))[0]
            : undefined;
          const isScar = !!scarTrigger;
          const attemptIds = unique([
            ...(attemptEventIds.get(item.attemptId) ?? []),
            ...(scarTrigger ? [scarTrigger.eventId] : []),
          ]);
          nodes.push({
            id: attemptNodeId,
            kind: 'attempt',
            label: `Attempt ${item.attempt}`,
            status: statusFromAttempt(item.status),
            sessionId,
            graphId: graph.id,
            moduleId: task.moduleId,
            taskId: task.id,
            attemptId: item.attemptId,
            attempt: item.attempt,
            parentId: taskNode.id,
            eventIds: attemptIds,
            evidenceIds: item.evidenceIds ?? [],
            ...(item.acceptanceId ? { acceptanceId: item.acceptanceId } : {}),
            ...(item.error || item.unknownReason ? { error: item.error ?? item.unknownReason } : {}),
            leaseHeld: item.status === 'running' && !!item.worktreeId && !!item.worktreePath,
            pulse: item.status === 'running' && !!item.worktreeId && !!item.worktreePath
              && !!item.branch && !!item.baseRevision,
            scar: isScar,
          });
          edges.push({
            id: `contains:${taskNode.id}:${attemptNodeId}`,
            sourceId: taskNode.id,
            targetId: attemptNodeId,
            kind: 'hierarchy',
            eventIds: attemptIds,
            flowCount: 0,
          });
          if (isScar) scars.push(item.attemptId);
          const outcome = attemptOutcome(item.status);
          const eventId = attemptTerminalEvent.get(item.attemptId);
          if (outcome && eventId) rings.push({
            id: `ring:${item.attemptId}`,
            taskId: task.id,
            attemptId: item.attemptId,
            outcome,
            eventId,
          });
        }

        const successes = successEventsByTask.get(`${graph.id}\u0000${task.id}`) ?? [];
        if (successes.length > 0) {
          const successEventIds = successes.map((event) => event.eventId);
          const taskEdge = edges.find((edge) => edge.targetId === taskNode.id && edge.kind === 'hierarchy');
          if (taskEdge) {
            taskEdge.flowCount = successes.length;
            taskEdge.eventIds = unique([...taskEdge.eventIds, ...successEventIds]);
          }
          flow.push({
            scope: 'task',
            taskId: task.id,
            moduleId,
            count: successes.length,
            eventIds: successEventIds,
          });
        }
      }

      const moduleTaskNodes = tasks.map((task) => taskNodeByGraphTask.get(`${graph.id}\u0000${task.id}`)!);
      moduleNode.status = aggregateStatus(moduleTaskNodes.map((node) => node.status));
      moduleNode.eventIds = unique([...graphIds, ...moduleTaskNodes.flatMap((node) => node.eventIds)]);
      moduleNode.evidenceIds = unique(moduleTaskNodes.flatMap((node) => node.evidenceIds));
      const moduleSuccesses = tasks.flatMap((task) => successEventsByTask.get(`${graph.id}\u0000${task.id}`) ?? []);
      if (moduleSuccesses.length > 0) {
        const successEventIds = moduleSuccesses.map((event) => event.eventId);
        const sessionEdge = edges.find((edge) => edge.targetId === moduleNode.id && edge.kind === 'hierarchy');
        if (sessionEdge) {
          sessionEdge.flowCount = moduleSuccesses.length;
          sessionEdge.eventIds = unique([...sessionEdge.eventIds, ...successEventIds]);
        }
        flow.push({
          scope: 'module',
          moduleId,
          count: moduleSuccesses.length,
          eventIds: successEventIds,
        });
      }
      const sourceEvents = visibleEvents.filter((event) => moduleNode.eventIds.includes(event.eventId));
      const occurredAt = sourceEvents.at(-1)?.occurredAt ?? graph.updatedAt;
      const capsule = makeCapsule(graph, moduleId, tasks, taskNodeByGraphTask, execution.lastSequence, occurredAt);
      if (capsule) capsules.push(capsule);
    }

    for (const task of graph.tasks) {
      const taskNode = taskNodeByGraphTask.get(`${graph.id}\u0000${task.id}`)!;
      for (const dependencyId of task.dependsOn) {
        const dependencyNodeId = `task:${graph.id}:${dependencyId}`;
        edges.push({
          id: `depends:${graph.id}:${dependencyId}:${task.id}`,
          sourceId: dependencyNodeId,
          targetId: taskNode.id,
          kind: 'dependency',
          eventIds: graphIds,
          flowCount: 0,
        });
      }
    }

    const sessionModuleNodes = [...moduleNodeById.values()];
    const linkedSessionEventIds = sessionEventIds.get(sessionId) ?? graphIds;
    nodes.push({
      id: sessionNodeId,
      kind: 'session',
      label: sessionId,
      status: aggregateStatus(sessionModuleNodes.map((node) => node.status)),
      sessionId,
      eventIds: unique([
        ...linkedSessionEventIds,
        ...sessionModuleNodes.flatMap((node) => node.eventIds),
      ]),
      evidenceIds: unique(sessionModuleNodes.flatMap((node) => node.evidenceIds)),
      leaseHeld: false,
      pulse: false,
      scar: false,
    });
  }

  const rank: Record<GraphGrowthNode['kind'], number> = { session: 0, module: 1, task: 2, attempt: 3 };
  const orderedNodes = nodes.sort((left, right) => rank[left.kind] - rank[right.kind]
    || left.id.localeCompare(right.id));
  const edgeRank: Record<GraphGrowthEdge['kind'], number> = { hierarchy: 0, dependency: 1 };
  const orderedEdges = edges.sort((left, right) => edgeRank[left.kind] - edgeRank[right.kind]
    || left.id.localeCompare(right.id));

  return {
    uptoSeq,
    lastSequence: visibleEvents.at(-1)?.sequence ?? 0,
    nodes: orderedNodes,
    edges: orderedEdges,
    flow,
    scars: unique(scars),
    rings,
    capsules,
    markers,
    legacyGraphIds: replayedGraphs.legacyGraphIds,
  };
}
