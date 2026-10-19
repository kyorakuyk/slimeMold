import type { Dispatch, SetStateAction } from 'react';
import type { DomainEvent } from '../../domain/contracts';
import { createExecutionDraftCreatedEvent, linkOrchestrationCommand } from '../../projectControl/commands';
import { enqueueWorkerRunCommand } from '../../projectControl/workerRun';
import { installWorkerRunRuntime } from '../../projectControl/workerRunRuntime';
import { projectWorkerRunsOntoOrchestrations } from '../../projectControl/workerRunOrchestrationProjection';
import { buildExecutionDraftFromTaskGraph } from '../../projectControl/executionPlan';
import { confirmDraft, createOrchestration } from '../../orchestrator/confirm';
import { buildConstructionWorkflow, buildOpsWorkflow } from '../../engine/builder';
import type { MasterResponse } from '../../projectControl/master';
import type { ProjectControlSnapshot, ProjectSession } from '../../projectControl/types';
import type { WorkerRuntime } from '../../projectControl/workerRunCoordinator';
import { useWorkflowStore } from '../../store/workflowStore';

type UseProjectSessionOrchestrationActionsOptions = {
  sessionId: string;
  projectName: string | null;
  workerRuntime: WorkerRuntime;
  onRunWorker?: (runId: string, runtime?: WorkerRuntime) => Promise<void> | void;
  createId: (prefix: string) => string;
  findSession: (snapshot: ProjectControlSnapshot, sessionId: string) => ProjectSession | null;
  persistControlMutation: (
    projectId: string,
    snapshot: ProjectControlSnapshot,
    events: readonly DomainEvent[],
  ) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLocalResponse: Dispatch<SetStateAction<MasterResponse | null>>;
};

export default function useProjectSessionOrchestrationActions({
  sessionId,
  projectName,
  workerRuntime,
  onRunWorker,
  createId,
  findSession,
  persistControlMutation,
  setError,
  setLocalResponse,
}: UseProjectSessionOrchestrationActionsOptions) {
  const handleCreateOrchestration = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const taskGraphId = currentSession?.taskGraphId;
    const graph = taskGraphId
      ? snapshot.taskGraphs?.find((item) => item.id === taskGraphId)
      : undefined;
    if (!currentSession || !graph || graph.approval !== 'approved' || currentSession.orchestrationId) return;
    try {
      const brief = currentSession.briefId
        ? snapshot.briefs.find((item) => item.id === currentSession.briefId)
        : undefined;
      const modules = graph.tasks.map((task) => ({
        name: task.moduleId,
        responsibility: task.description,
        scope: task.scope,
        dependsOn: task.dependsOn,
        category: task.category,
      }));
      const agents = [...(state.globalAgents ?? []), ...state.agents];
      const fallbackAgentId = state.defaultAgentId ?? state.agents[0]?.id ?? null;
      const constructionWf = buildConstructionWorkflow({
        modules,
        routeTable: state.agentRouteTable ?? {},
        fallbackAgentId,
        agents,
        name: `${projectName ?? '项目'} · 施工`,
      });
      const acceptanceWf = buildOpsWorkflow({
        fallbackAgentId,
        name: `${projectName ?? '项目'} · 验收与运维`,
      });
      const constructionId = state.registerWorkflow(constructionWf, { activate: false });
      const acceptanceId = state.registerWorkflow(acceptanceWf, { activate: false });
      const draft = buildExecutionDraftFromTaskGraph({
        goal: brief?.goal ?? projectName ?? '未命名项目',
        taskGraph: graph,
        workflowIds: { construction: constructionId, acceptance: acceptanceId },
      });
      const orchestration = createOrchestration(brief?.goal ?? projectName ?? '项目执行', draft);
      const now = new Date().toISOString();
      const next = linkOrchestrationCommand({
        snapshot,
        sessionId,
        orchestrationId: orchestration.id,
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, [
        createExecutionDraftCreatedEvent({
          projectId: currentSession.projectId,
          sessionId: currentSession.id,
          orchestration,
          taskGraphId: graph.id,
          taskGraphVersion: graph.graphVersion,
          now,
        }),
        ...next.events,
      ]);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleConfirmExecutionPlan = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const orchestrationId = currentSession?.orchestrationId;
    const orchestration = orchestrationId
      ? state.orchestrations.find((item) => item.id === orchestrationId)
      : undefined;
    const taskGraph = currentSession?.taskGraphId
      ? snapshot.taskGraphs?.find((item) => item.id === currentSession.taskGraphId)
      : undefined;
    if (!currentSession || !orchestration || !taskGraph || orchestration.status !== 'awaiting-confirm') return;
    try {
      const now = new Date().toISOString();
      const queued = enqueueWorkerRunCommand({
        projectId: currentSession.projectId,
        orchestrationId: orchestration.id,
        runId: createId('run'),
        taskGraph,
        existingRuns: state.workerRuns,
        now,
      });
      const approved = confirmDraft(orchestration.id, 'approved');
      const nextWorkerRuns = [...state.workerRuns, queued.state];
      state.setWorkerRuns(nextWorkerRuns);
      state.setOrchestrations(
        projectWorkerRunsOntoOrchestrations(
          useWorkflowStore.getState().orchestrations,
          nextWorkerRuns,
        ),
      );
      const runtime = installWorkerRunRuntime({
        projectId: currentSession.projectId,
        taskGraphs: snapshot.taskGraphs ?? [],
        runs: [...state.workerRuns, queued.state],
      });
      state.setWorkerRunRecoveries(runtime.recoveries);
      await persistControlMutation(currentSession.projectId, snapshot, [{
        eventId: `${approved.id}:execution-draft-approved:${now}`,
        streamId: currentSession.projectId,
        aggregateType: 'Orchestration',
        aggregateId: approved.id,
        eventType: 'ExecutionDraftApproved',
        schemaVersion: 1,
        sequence: 1,
        aggregateVersion: 1,
        payload: {
          orchestrationId: approved.id,
          sessionId: currentSession.id,
          draftStageIds: approved.draft?.stages.map((stage) => stage.id) ?? [],
        },
        actor: 'user',
        occurredAt: now,
        correlationId: currentSession.id,
        source: { objectId: approved.id, objectVersion: 1 },
        sensitivity: 'normal',
      }, ...queued.events]);
      if (onRunWorker) {
        void Promise.resolve(onRunWorker(queued.state.runId, workerRuntime)).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return { handleCreateOrchestration, handleConfirmExecutionPlan };
}
