import { useT } from '../../i18n/useT';
import ProjectSessionArtifactsSidebar from './ProjectSessionArtifactsSidebar';
import ProjectSessionConversationSection from './ProjectSessionConversationSection';
import ProjectSessionNextStepCard from './ProjectSessionNextStepCard';
import ProjectSessionTopSection from './ProjectSessionTopSection';
import type { ProjectSessionPanelViewProps } from './ProjectSessionPanelView.types';

export default function ProjectSessionPanelView({
  projectName,
  projectDirty,
  projectControl,
  session,
  sessionStatusLabel,
  currentBrief,
  currentArchitecture,
  currentTaskGraph,
  currentOrchestration,
  currentWorkerRun,
  currentWorkerRunRecovery,
  currentWorkerRecoveryActions,
  workerRunCopy,
  input,
  onInputChange,
  busy,
  error,
  recoveryBusy,
  workerStartBusy,
  workerRuntime,
  onWorkerRuntimeChange,
  streamingText,
  localResponse,
  visibleQuestions,
  localReplyVisible,
  canRunWorker,
  canRecoverWorkerRun,
  onBackHome,
  onOpenAdvanced,
  onOpenIssues,
  onOpenMasterAgent,
  onStartQueuedWorker,
  onSubmit,
  onWorkerRecovery,
  onApproveBrief,
  onGenerateArchitecture,
  onApproveArchitecture,
  onGenerateTaskGraph,
  onApproveTaskGraph,
  onCreateOrchestration,
  onConfirmExecutionPlan,
}: ProjectSessionPanelViewProps) {
  const t = useT('beginner');

  return (
    <div className="sm-beginner-shell">
      <main className="sm-beginner-main sm-beginner-session-main">
        <ProjectSessionTopSection
          projectDirty={projectDirty}
          onBackHome={onBackHome}
          onOpenMasterAgent={onOpenMasterAgent}
          onOpenIssues={onOpenIssues}
          currentWorkerRun={currentWorkerRun}
          currentWorkerRunRecovery={currentWorkerRunRecovery}
          canRunWorker={canRunWorker}
          workerRuntime={workerRuntime}
          workerStartBusy={workerStartBusy}
          onWorkerRuntimeChange={onWorkerRuntimeChange}
          onStartQueuedWorker={onStartQueuedWorker}
          onOpenAdvanced={onOpenAdvanced}
          projectName={projectName}
          sessionStatusLabel={sessionStatusLabel}
          t={t}
        />

        <div className="sm-beginner-session-grid">
          <ProjectSessionConversationSection
            session={session}
            busy={busy}
            streamingText={streamingText}
            localResponse={localResponse}
            localReplyVisible={localReplyVisible}
            visibleQuestions={visibleQuestions}
            input={input}
            onInputChange={onInputChange}
            onSubmit={onSubmit}
            error={error}
            t={t}
          />

          <aside className="sm-beginner-session-sidebar">
            <ProjectSessionArtifactsSidebar
              projectControl={projectControl}
              session={session}
              currentBrief={currentBrief}
              currentArchitecture={currentArchitecture}
              currentTaskGraph={currentTaskGraph}
              onApproveBrief={onApproveBrief}
              onApproveArchitecture={onApproveArchitecture}
              onApproveTaskGraph={onApproveTaskGraph}
              t={t}
            />
            <ProjectSessionNextStepCard
              workerRunCopy={workerRunCopy}
              currentOrchestration={currentOrchestration}
              currentTaskGraph={currentTaskGraph}
              currentArchitecture={currentArchitecture}
              currentBrief={currentBrief}
              currentWorkerRunRecovery={currentWorkerRunRecovery}
              currentWorkerRecoveryActions={currentWorkerRecoveryActions}
              canRecoverWorkerRun={canRecoverWorkerRun}
              recoveryBusy={recoveryBusy}
              busy={busy}
              onWorkerRecovery={onWorkerRecovery}
              onGenerateArchitecture={onGenerateArchitecture}
              onCreateOrchestration={onCreateOrchestration}
              onGenerateTaskGraph={onGenerateTaskGraph}
              onConfirmExecutionPlan={onConfirmExecutionPlan}
              onOpenAdvanced={onOpenAdvanced}
              t={t}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}
