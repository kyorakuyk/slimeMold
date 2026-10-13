import {
  ArrowRight,
  TriangleAlert,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import type { DomainEvent } from '../domain/contracts';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import { projectWorkerRecoveryActions } from '../projectControl/workerRecoveryCapabilityProjection';
import type { WorkerRunRecoveryDecision } from '../projectControl/workerSideEffects';
import type { MasterResponse } from '../projectControl/master';
import { selectLatestWorkerRun } from '../projectControl/workerRunOrchestrationProjection';
import type { ProjectControlSnapshot, ProjectSession } from '../projectControl/types';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';
import ProjectSessionPanelView from './projectSession/ProjectSessionPanelView';
import useProjectSessionConversation from './projectSession/useProjectSessionConversation';
import useProjectSessionOrchestrationActions from './projectSession/useProjectSessionOrchestrationActions';
import useProjectSessionPlanningActions from './projectSession/useProjectSessionPlanningActions';
import useProjectSessionWorkerActions from './projectSession/useProjectSessionWorkerActions';

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

  const {
    recoveryBusy,
    workerStartBusy,
    workerRuntime,
    setWorkerRuntime,
    handleWorkerRecovery,
    handleStartQueuedWorker,
  } = useProjectSessionWorkerActions({
    currentWorkerRun,
    currentWorkerRunRecovery,
    currentWorkerRecoveryActions,
    onRunWorker,
    onRecoverWorkerRun,
    setError,
  });

  const {
    handleApproveBrief,
    handleApproveArchitecture,
    handleGenerateTaskGraph,
    handleApproveTaskGraph,
  } = useProjectSessionPlanningActions({
    sessionId,
    createId: controlId,
    findSession,
    persistControlMutation,
    setError,
    setLocalResponse,
  });

  const { handleCreateOrchestration, handleConfirmExecutionPlan } = useProjectSessionOrchestrationActions({
    sessionId,
    projectName,
    workerRuntime,
    onRunWorker,
    createId: controlId,
    findSession,
    persistControlMutation,
    setError,
    setLocalResponse,
  });

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
