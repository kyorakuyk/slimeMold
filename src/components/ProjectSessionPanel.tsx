import { useState } from 'react';
import {
  ArrowRight,
  TriangleAlert,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import type { DomainEvent } from '../domain/contracts';
import {
  approveArchitectureCommand,
  approveBriefCommand,
  approveTaskGraphCommand,
  createExecutionDraftCreatedEvent,
  generateTaskGraphCommand,
  linkOrchestrationCommand,
} from '../projectControl/commands';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import { enqueueWorkerRunCommand } from '../projectControl/workerRun';
import { installWorkerRunRuntime } from '../projectControl/workerRunRuntime';
import { projectWorkerRecoveryActions } from '../projectControl/workerRecoveryCapabilityProjection';
import type { WorkerRunRecoveryDecision } from '../projectControl/workerSideEffects';
import type { MasterResponse } from '../projectControl/master';
import { buildExecutionDraftFromTaskGraph } from '../projectControl/executionPlan';
import { projectWorkerRunsOntoOrchestrations, selectLatestWorkerRun } from '../projectControl/workerRunOrchestrationProjection';
import { confirmDraft, createOrchestration } from '../orchestrator/confirm';
import { buildConstructionWorkflow, buildOpsWorkflow } from '../engine/builder';
import type { ProjectControlSnapshot, ProjectSession } from '../projectControl/types';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';
import ProjectSessionPanelView from './projectSession/ProjectSessionPanelView';
import useProjectSessionConversation from './projectSession/useProjectSessionConversation';

interface ProjectSessionPanelProps {
  sessionId: string;
  onBackHome: () => void;
  onOpenAdvanced: () => void;
  onOpenIssues?: () => void;
  onOpenMasterAgent?: () => void;
  onRunWorker?: (runId: string, runtime?: 'codex' | 'antigravity') => Promise<void> | void;
  onRecoverWorkerRun?: (runId: string, decision: Exclude<WorkerRunRecoveryDecision, 'inspect'>, reason: string, runtime?: WorkerRuntime) => Promise<void> | void;
}

function controlId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}

function sessionStatusKey(status: ProjectSession['status']): string {
  return `session.status.${status}`;
}

function findSession(snapshot: ProjectControlSnapshot, sessionId: string): ProjectSession | null {
  return snapshot.sessions.find((session) => session.id === sessionId) ?? null;
}

async function persistControlMutation(
  projectId: string,
  snapshot: ProjectControlSnapshot,
  events: readonly DomainEvent[],
): Promise<void> {
  recordProjectEvents(projectId, events);
  const store = useWorkflowStore.getState();
  store.setProjectControl(snapshot);
  if (store.projectPath) await store.saveProject();
}

function responseQuestions(
  session: ProjectSession,
  response: MasterResponse | null,
): Array<{ id: string; prompt: string; status: 'open' | 'answered' | 'deferred'; answer?: string }> {
  const questions = [...session.openQuestions];
  if (response?.kind === 'question') {
    for (const question of response.questions) {
      if (!questions.some((item) => item.id === question.id)) {
        questions.push({ id: question.id, prompt: question.prompt, status: 'open', createdAt: session.updatedAt });
      }
    }
  }
  return questions;
}

export default function ProjectSessionPanel({
  sessionId,
  onBackHome,
  onOpenAdvanced,
  onOpenIssues,
  onOpenMasterAgent,
  onRunWorker,
  onRecoverWorkerRun,
}: ProjectSessionPanelProps) {
  const t = useT('beginner');
  const projectName = useWorkflowStore((state) => state.projectName);
  const projectDirty = useWorkflowStore((state) => state.projectDirty);
  const orchestrations = useWorkflowStore((state) => state.orchestrations);
  const workerRuns = useWorkflowStore((state) => state.workerRuns);
  const projectControl = useWorkflowStore((state) => state.projectControl);
  const workerRunRecoveries = useWorkflowStore((state) => state.workerRunRecoveries ?? []);
  const workerRunSideEffects = useWorkflowStore((state) => state.workerRunSideEffects ?? []);
  const globalMasterAgentId = useViewStore((state) => state.globalMasterAgentId);

  const session = findSession(projectControl, sessionId);
  const currentBrief = session?.briefId
    ? projectControl.briefs.find((brief) => brief.id === session.briefId) ?? null
    : null;
  const currentArchitecture = session?.architectureId
    ? projectControl.architectures.find((architecture) => architecture.id === session.architectureId) ?? null
    : null;
  const currentTaskGraph = session?.taskGraphId
    ? projectControl.taskGraphs?.find((graph) => graph.id === session.taskGraphId) ?? null
    : null;
  const currentOrchestration = session?.orchestrationId
    ? orchestrations.find((orchestration) => orchestration.id === session.orchestrationId) ?? null
    : null;
  const currentWorkerRun = session?.orchestrationId
    ? selectLatestWorkerRun(workerRuns, session.orchestrationId)
    : null;
  const currentWorkerRunRecovery = currentWorkerRun
    && (currentWorkerRun.status !== 'queued'
      || Object.values(currentWorkerRun.tasks).some((task) => ['failed', 'running', 'blocked', 'waiting-feedback'].includes(task.status)))
    ? workerRunRecoveries.find((item) => item.runId === currentWorkerRun.runId) ?? null
    : null;
  const currentWorkerRecoveryActions = currentWorkerRun && currentWorkerRunRecovery
    ? projectWorkerRecoveryActions({
      run: currentWorkerRun,
      recovery: currentWorkerRunRecovery,
      taskGraph: currentTaskGraph,
      sideEffects: workerRunSideEffects,
    })
    : [];
  const workerRunCopy = currentWorkerRunRecovery
    ? {
        title: t('session.workerRun.recovery'),
        hint: t('session.workerRun.recoveryHint'),
      }
    : currentWorkerRun
    ? {
        title: t(`session.workerRun.${currentWorkerRun.status}`),
        hint: t(`session.workerRun.${currentWorkerRun.status}Hint`),
      }
    : null;
  const {
    input,
    setInput,
    busy,
    error,
    setError,
    streamingText,
    localResponse,
    setLocalResponse,
    visibleQuestions,
    localReplyVisible,
    handleSubmit,
    handleGenerateArchitecture,
  } = useProjectSessionConversation({
    sessionId,
    session,
    currentBrief,
    currentArchitecture,
    globalMasterAgentId,
    t,
    createId: controlId,
    findSession,
    persistControlMutation,
    responseQuestions,
  });

  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [workerStartBusy, setWorkerStartBusy] = useState(false);
  const [workerRuntime, setWorkerRuntime] = useState<'codex' | 'antigravity'>('codex');

  const handleWorkerRecovery = (decision: Exclude<WorkerRunRecoveryDecision, 'inspect'>) => {
    if (!onRecoverWorkerRun || !currentWorkerRun || recoveryBusy || !currentWorkerRecoveryActions.includes(decision)) return;
    const runId = currentWorkerRun.runId;
    const reason = `用户在项目驾驶舱选择 ${decision}`;
    setRecoveryBusy(true);
    setError(null);
    void (async () => {
      try {
        await onRecoverWorkerRun(runId, decision, reason, workerRuntime);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRecoveryBusy(false);
      }
    })();
  };

  const handleStartQueuedWorker = () => {
    if (!onRunWorker || !currentWorkerRun || currentWorkerRun.status !== 'queued' || currentWorkerRunRecovery || workerStartBusy) return;
    setWorkerStartBusy(true);
    setError(null);
    void Promise.resolve(onRunWorker(currentWorkerRun.runId, workerRuntime))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setWorkerStartBusy(false));
  };

  const handleApproveBrief = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const briefId = currentSession?.briefId;
    const brief = briefId ? snapshot.briefs.find((item) => item.id === briefId) : undefined;
    if (!currentSession || !brief) return;
    try {
      const now = new Date().toISOString();
      const next = approveBriefCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const handleApproveArchitecture = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const architectureId = currentSession?.architectureId;
    const architecture = architectureId
      ? snapshot.architectures.find((item) => item.id === architectureId)
      : undefined;
    if (!currentSession || !architecture) return;
    try {
      const now = new Date().toISOString();
      const next = approveArchitectureCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleGenerateTaskGraph = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const architectureId = currentSession?.architectureId;
    const architecture = architectureId
      ? snapshot.architectures.find((item) => item.id === architectureId)
      : undefined;
    if (!currentSession || !architecture || architecture.approval !== 'approved' || currentSession.taskGraphId) return;
    try {
      const now = new Date().toISOString();
      const next = generateTaskGraphCommand({
        snapshot,
        sessionId,
        id: controlId('task-graph'),
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApproveTaskGraph = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const taskGraphId = currentSession?.taskGraphId;
    const graph = taskGraphId
      ? snapshot.taskGraphs?.find((item) => item.id === taskGraphId)
      : undefined;
    if (!currentSession || !graph) return;
    try {
      const now = new Date().toISOString();
      const next = approveTaskGraphCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
        runId: controlId('run'),
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

  if (!session) {
    return (
      <div className="sm-beginner-shell">
        <main className="sm-beginner-main sm-beginner-session-main">
          <div className="sm-beginner-session-empty">
            <TriangleAlert size={22} />
            <strong>{t('session.error.noSession')}</strong>
            <button type="button" className="sm-beginner-small-button" onClick={onBackHome}>
              {t('project.back')} <ArrowRight size={14} />
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <ProjectSessionPanelView
      projectName={projectName}
      projectDirty={projectDirty}
      projectControl={projectControl}
      session={session}
      sessionStatusLabel={t(sessionStatusKey(session.status))}
      currentBrief={currentBrief}
      currentArchitecture={currentArchitecture}
      currentTaskGraph={currentTaskGraph}
      currentOrchestration={currentOrchestration}
      currentWorkerRun={currentWorkerRun}
      currentWorkerRunRecovery={currentWorkerRunRecovery}
      currentWorkerRecoveryActions={currentWorkerRecoveryActions}
      workerRunCopy={workerRunCopy}
      input={input}
      onInputChange={setInput}
      busy={busy}
      error={error}
      recoveryBusy={recoveryBusy}
      workerStartBusy={workerStartBusy}
      workerRuntime={workerRuntime}
      onWorkerRuntimeChange={setWorkerRuntime}
      streamingText={streamingText}
      localResponse={localResponse}
      visibleQuestions={visibleQuestions}
      localReplyVisible={localReplyVisible}
      canRunWorker={Boolean(onRunWorker)}
      canRecoverWorkerRun={Boolean(onRecoverWorkerRun)}
      onBackHome={onBackHome}
      onOpenAdvanced={onOpenAdvanced}
      onOpenIssues={onOpenIssues}
      onOpenMasterAgent={onOpenMasterAgent}
      onStartQueuedWorker={handleStartQueuedWorker}
      onSubmit={handleSubmit}
      onWorkerRecovery={handleWorkerRecovery}
      onApproveBrief={handleApproveBrief}
      onGenerateArchitecture={handleGenerateArchitecture}
      onApproveArchitecture={handleApproveArchitecture}
      onGenerateTaskGraph={handleGenerateTaskGraph}
      onApproveTaskGraph={handleApproveTaskGraph}
      onCreateOrchestration={handleCreateOrchestration}
      onConfirmExecutionPlan={handleConfirmExecutionPlan}
    />
  );
}
