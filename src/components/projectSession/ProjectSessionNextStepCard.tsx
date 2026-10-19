import { ArrowRight, CheckCircle2, ClipboardList, Loader2, Sparkles, Wrench } from 'lucide-react';
import type {
  ProjectSessionPanelViewProps,
  ProjectSessionViewTranslator,
} from './ProjectSessionPanelView.types';

type ProjectSessionNextStepCardProps = Pick<
  ProjectSessionPanelViewProps,
  | 'workerRunCopy'
  | 'currentOrchestration'
  | 'currentTaskGraph'
  | 'currentArchitecture'
  | 'currentBrief'
  | 'currentWorkerRunRecovery'
  | 'currentWorkerRecoveryActions'
  | 'canRecoverWorkerRun'
  | 'recoveryBusy'
  | 'busy'
  | 'onWorkerRecovery'
  | 'onGenerateArchitecture'
  | 'onCreateOrchestration'
  | 'onGenerateTaskGraph'
  | 'onConfirmExecutionPlan'
  | 'onOpenAdvanced'
> & { t: ProjectSessionViewTranslator };

export default function ProjectSessionNextStepCard(props: ProjectSessionNextStepCardProps) {
  return (
    <section className="sm-beginner-session-next-card">
      <ProjectSessionNextStepSummary
        workerRunCopy={props.workerRunCopy}
        currentOrchestration={props.currentOrchestration}
        currentTaskGraph={props.currentTaskGraph}
        currentArchitecture={props.currentArchitecture}
        currentBrief={props.currentBrief}
        t={props.t}
      />
      <ProjectSessionRecoveryActions
        currentWorkerRunRecovery={props.currentWorkerRunRecovery}
        currentWorkerRecoveryActions={props.currentWorkerRecoveryActions}
        canRecoverWorkerRun={props.canRecoverWorkerRun}
        recoveryBusy={props.recoveryBusy}
        onWorkerRecovery={props.onWorkerRecovery}
        t={props.t}
      />
      <ProjectSessionNextStepActions
        currentOrchestration={props.currentOrchestration}
        currentTaskGraph={props.currentTaskGraph}
        currentArchitecture={props.currentArchitecture}
        currentBrief={props.currentBrief}
        busy={props.busy}
        onGenerateArchitecture={props.onGenerateArchitecture}
        onCreateOrchestration={props.onCreateOrchestration}
        onGenerateTaskGraph={props.onGenerateTaskGraph}
        onConfirmExecutionPlan={props.onConfirmExecutionPlan}
        onOpenAdvanced={props.onOpenAdvanced}
        t={props.t}
      />
    </section>
  );
}

type ProjectSessionNextStepSummaryProps = Pick<
  ProjectSessionPanelViewProps,
  'workerRunCopy' | 'currentOrchestration' | 'currentTaskGraph' | 'currentArchitecture' | 'currentBrief'
> & { t: ProjectSessionViewTranslator };

function ProjectSessionNextStepSummary({
  workerRunCopy,
  currentOrchestration,
  currentTaskGraph,
  currentArchitecture,
  currentBrief,
  t,
}: ProjectSessionNextStepSummaryProps) {
  return (
    <>
      <p className="sm-beginner-eyebrow">{t('session.nextEyebrow')}</p>
      <strong>
        {workerRunCopy
          ? workerRunCopy.title
          : currentOrchestration?.status === 'awaiting-confirm'
          ? t('session.nextOrchestrationReview')
          : currentOrchestration
            ? t('session.nextOrchestration')
          : currentTaskGraph?.approval === 'approved'
            ? t('session.nextExecution')
            : currentTaskGraph
              ? t('session.reviewTaskGraph')
              : currentArchitecture?.approval === 'approved'
                ? t('session.nextPlan')
                : currentArchitecture
                  ? t('session.reviewArchitecture')
                  : currentBrief?.approval === 'approved'
                    ? t('session.nextArchitecture')
                    : t('session.nextQuestions')}
      </strong>
      <span>
        {workerRunCopy
          ? workerRunCopy.hint
          : currentOrchestration?.status === 'awaiting-confirm'
          ? t('session.nextOrchestrationReviewHint')
          : currentOrchestration
            ? t('session.nextOrchestrationHint')
          : currentTaskGraph?.approval === 'approved'
            ? t('session.nextExecutionHint')
            : currentTaskGraph
              ? t('session.reviewTaskGraphHint')
              : currentArchitecture?.approval === 'approved'
                ? t('session.nextPlanHint')
                : currentArchitecture
                  ? t('session.reviewArchitectureHint')
                  : currentBrief?.approval === 'approved'
                    ? t('session.nextArchitectureHint')
                    : t('session.nextQuestionsHint')}
      </span>
    </>
  );
}

type ProjectSessionRecoveryActionsProps = Pick<
  ProjectSessionPanelViewProps,
  | 'currentWorkerRunRecovery'
  | 'currentWorkerRecoveryActions'
  | 'canRecoverWorkerRun'
  | 'recoveryBusy'
  | 'onWorkerRecovery'
> & { t: ProjectSessionViewTranslator };

function ProjectSessionRecoveryActions({
  currentWorkerRunRecovery,
  currentWorkerRecoveryActions,
  canRecoverWorkerRun,
  recoveryBusy,
  onWorkerRecovery,
  t,
}: ProjectSessionRecoveryActionsProps) {
  if (!currentWorkerRunRecovery) return null;
  return (
    <div className="sm-beginner-session-recovery" data-testid="beginner-session-worker-recovery">
      <strong>{t('session.workerRun.recoveryChoices')}</strong>
      <ul>
        <li>{t('session.workerRun.recovery.inspect')}</li>
        {currentWorkerRecoveryActions.includes('retry') && <li>{t('session.workerRun.recovery.retry')}</li>}
        {currentWorkerRecoveryActions.includes('skip') && <li>{t('session.workerRun.recovery.skip')}</li>}
      </ul>
      {canRecoverWorkerRun && currentWorkerRecoveryActions.length > 0 && (
        <div className="sm-beginner-session-recovery-actions">
          {currentWorkerRecoveryActions.includes('retry') && (
            <button
              type="button"
              data-testid="beginner-session-worker-retry"
              className="sm-beginner-small-button"
              disabled={recoveryBusy}
              onClick={() => onWorkerRecovery('retry')}
            >
              {t('session.workerRun.recovery.retryAction')}
            </button>
          )}
          {currentWorkerRecoveryActions.includes('skip') && (
            <button
              type="button"
              data-testid="beginner-session-worker-skip"
              className="sm-beginner-small-button"
              disabled={recoveryBusy}
              onClick={() => onWorkerRecovery('skip')}
            >
              {t('session.workerRun.recovery.skipAction')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type ProjectSessionNextStepActionsProps = Pick<
  ProjectSessionPanelViewProps,
  | 'currentOrchestration'
  | 'currentTaskGraph'
  | 'currentArchitecture'
  | 'currentBrief'
  | 'busy'
  | 'onGenerateArchitecture'
  | 'onCreateOrchestration'
  | 'onGenerateTaskGraph'
  | 'onConfirmExecutionPlan'
  | 'onOpenAdvanced'
> & { t: ProjectSessionViewTranslator };

function ProjectSessionNextStepActions({
  currentOrchestration,
  currentTaskGraph,
  currentArchitecture,
  currentBrief,
  busy,
  onGenerateArchitecture,
  onCreateOrchestration,
  onGenerateTaskGraph,
  onConfirmExecutionPlan,
  onOpenAdvanced,
  t,
}: ProjectSessionNextStepActionsProps) {
  return (
    <>
      {currentBrief?.approval === 'approved' && !currentArchitecture && (
        <button type="button" data-testid="beginner-session-generate-architecture" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onGenerateArchitecture} disabled={busy}>
          {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <Sparkles size={16} />}
          {busy ? t('session.thinking') : t('session.generateArchitecture')}
        </button>
      )}
      {currentTaskGraph?.approval === 'approved' && !currentOrchestration && (
        <button type="button" data-testid="beginner-session-generate-orchestration" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onCreateOrchestration} disabled={busy}>
          <Wrench size={16} /> {t('session.generateOrchestration')}
        </button>
      )}
      {currentArchitecture?.approval === 'approved' && !currentTaskGraph && (
        <button type="button" data-testid="beginner-session-generate-task-graph" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onGenerateTaskGraph} disabled={busy}>
          {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <ClipboardList size={16} />}
          {busy ? t('session.thinking') : t('session.generateTaskGraph')}
        </button>
      )}
      {currentOrchestration?.status === 'awaiting-confirm' && (
        <button type="button" data-testid="beginner-session-confirm-execution-plan" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onConfirmExecutionPlan}>
          <CheckCircle2 size={16} /> {t('session.confirmExecutionPlan')}
        </button>
      )}
      {currentOrchestration && currentOrchestration.status !== 'awaiting-confirm' && (
        <button type="button" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onOpenAdvanced}>
          <ArrowRight size={16} /> {t('session.openOrchestration')}
        </button>
      )}
    </>
  );
}
