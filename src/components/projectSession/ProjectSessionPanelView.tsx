import type { FormEventHandler } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  CircleDashed,
  FileText,
  Loader2,
  MessageCircle,
  Send,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useT } from '../../i18n/useT';
import type { WorkerRunQueueState } from '../../domain/workerQueue';
import type { MasterResponse } from '../../projectControl/master';
import type {
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectSession,
  ProjectTaskGraph,
} from '../../projectControl/types';
import type { WorkerRecoveryAction } from '../../projectControl/workerRecoveryCapabilityProjection';
import type { WorkerRunRecovery } from '../../projectControl/workerRunRuntime';
import type { WorkerRuntime } from '../../projectControl/workerRunCoordinator';
import type { Orchestration } from '../../types/orchestration';

type VisibleQuestion = {
  id: string;
  prompt: string;
  status: 'open' | 'answered' | 'deferred';
  answer?: string;
};

type ProjectSessionPanelViewProps = {
  projectName: string | null;
  projectDirty: boolean;
  projectControl: ProjectControlSnapshot;
  session: ProjectSession;
  sessionStatusLabel: string;
  currentBrief: ProjectBrief | null;
  currentArchitecture: ProjectArchitecture | null;
  currentTaskGraph: ProjectTaskGraph | null;
  currentOrchestration: Orchestration | null;
  currentWorkerRun: WorkerRunQueueState | null;
  currentWorkerRunRecovery: WorkerRunRecovery | null;
  currentWorkerRecoveryActions: readonly WorkerRecoveryAction[];
  workerRunCopy: { title: string; hint: string } | null;
  input: string;
  onInputChange: (value: string) => void;
  busy: boolean;
  error: string | null;
  recoveryBusy: boolean;
  workerStartBusy: boolean;
  workerRuntime: WorkerRuntime;
  onWorkerRuntimeChange: (runtime: WorkerRuntime) => void;
  streamingText: string;
  localResponse: MasterResponse | null;
  visibleQuestions: VisibleQuestion[];
  localReplyVisible: boolean;
  canRunWorker: boolean;
  canRecoverWorkerRun: boolean;
  onBackHome: () => void;
  onOpenAdvanced: () => void;
  onOpenIssues?: () => void;
  onOpenMasterAgent?: () => void;
  onStartQueuedWorker: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onWorkerRecovery: (decision: WorkerRecoveryAction) => void;
  onApproveBrief: () => void;
  onGenerateArchitecture: () => void;
  onApproveArchitecture: () => void;
  onGenerateTaskGraph: () => void;
  onApproveTaskGraph: () => void;
  onCreateOrchestration: () => void;
  onConfirmExecutionPlan: () => void;
};

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
        <div className="sm-beginner-session-topline">
          <button type="button" className="sm-beginner-back-link" onClick={onBackHome}>
            <ArrowLeft size={14} /> {t('session.back')}
          </button>
          <div className="sm-beginner-session-top-actions">
            {projectDirty && <span className="sm-beginner-session-dirty">{t('project.unsaved')}</span>}
            {onOpenMasterAgent && (
              <button type="button" className="sm-beginner-text-button" onClick={onOpenMasterAgent}>
                {t('session.openMasterAgent')} <ArrowRight size={14} />
              </button>
            )}
            {onOpenIssues && (
              <button type="button" className="sm-beginner-text-button" onClick={onOpenIssues}>
                {t('session.openIssues')} <ArrowRight size={14} />
              </button>
            )}
            {currentWorkerRun?.status === 'queued' && !currentWorkerRunRecovery && canRunWorker && (
              <>
                <label className="sm-beginner-worker-runtime" title={workerRuntime === 'antigravity' ? t('session.workerRuntime.antigravityHint') : undefined}>
                  <span>{t('session.workerRuntime.label')}</span>
                  <select
                    aria-label={t('session.workerRuntime.label')}
                    value={workerRuntime}
                    onChange={(event) => onWorkerRuntimeChange(event.target.value as WorkerRuntime)}
                    disabled={workerStartBusy}
                  >
                    <option value="codex">{t('session.workerRuntime.codex')}</option>
                    <option value="antigravity">{t('session.workerRuntime.antigravity')}</option>
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="beginner-session-start-worker"
                  className="sm-beginner-text-button"
                  disabled={workerStartBusy}
                  onClick={onStartQueuedWorker}
                >
                  {workerStartBusy ? t('session.thinking') : t('session.workerRun.start')} <ArrowRight size={14} />
                </button>
              </>
            )}
            <button type="button" className="sm-beginner-text-button" onClick={onOpenAdvanced}>
              {t('session.openAdvanced')} <ArrowRight size={14} />
            </button>
          </div>
        </div>

        <section className="sm-beginner-session-heading" aria-labelledby="project-session-title">
          <div className="sm-beginner-session-heading-icon"><MessageCircle size={22} /></div>
          <div>
            <p className="sm-beginner-eyebrow">{t('session.eyebrow')}</p>
            <h1 id="project-session-title">{projectName || t('project.local')}</h1>
            <p>{sessionStatusLabel}</p>
          </div>
        </section>

        <div className="sm-beginner-session-grid">
          <section className="sm-beginner-session-conversation" aria-label={t('session.conversation')}>
            <div className="sm-beginner-session-card-heading">
              <div>
                <p className="sm-beginner-eyebrow">{t('session.conversationEyebrow')}</p>
                <h2>{t('session.conversation')}</h2>
              </div>
              {busy && <Loader2 size={17} className="sm-beginner-spin" />}
            </div>

            <div className="sm-beginner-session-messages">
              {session.messages.map((message) => (
                <div key={message.id} className={`sm-beginner-session-message is-${message.role}`}>
                  <span className="sm-beginner-session-message-role">
                    {message.role === 'user' ? t('session.you') : t('session.master')}
                  </span>
                  <p>{message.content}</p>
                </div>
              ))}
              {localReplyVisible && localResponse && (
                <div className="sm-beginner-session-message is-assistant">
                  <span className="sm-beginner-session-message-role">{t('session.master')}</span>
                  <p>{localResponse.reply}</p>
                </div>
              )}
              {busy && streamingText && (
                <div className="sm-beginner-session-live-output" aria-live="polite">
                  {streamingText}
                </div>
              )}
            </div>

            {visibleQuestions.length > 0 && (
              <div className="sm-beginner-session-question-list">
                <div className="sm-beginner-session-subheading">
                  <CircleDashed size={15} /> {t('session.openQuestions')}
                </div>
                {visibleQuestions.map((question) => (
                  <div key={question.id} className={`sm-beginner-session-question is-${question.status}`}>
                    <span>{question.status === 'answered' ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}</span>
                    <div>
                      <strong>{question.prompt}</strong>
                      {question.answer && <p>{question.answer}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form className="sm-beginner-session-composer" onSubmit={onSubmit}>
              <label htmlFor="project-session-input">{t('session.replyLabel')}</label>
              <textarea
                id="project-session-input"
                value={input}
                onChange={(event) => onInputChange(event.target.value)}
                placeholder={busy ? t('session.thinking') : t('session.placeholder')}
                disabled={busy}
                rows={4}
              />
              <div className="sm-beginner-session-composer-footer">
                <span>{t('session.safetyNote')}</span>
                <button
                  type="submit"
                  data-testid="beginner-session-submit"
                  className="sm-beginner-primary-button"
                  disabled={busy || !input.trim()}
                >
                  {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <Send size={16} />}
                  {busy ? t('session.thinking') : t('session.send')}
                </button>
              </div>
            </form>
            {error && <p className="sm-beginner-inline-error" role="alert">{error}</p>}
          </section>

          <aside className="sm-beginner-session-sidebar">
            <section className="sm-beginner-session-context-card">
              <div className="sm-beginner-session-card-heading">
                <div>
                  <p className="sm-beginner-eyebrow">{t('session.contextEyebrow')}</p>
                  <h2>{t('session.currentUnderstanding')}</h2>
                </div>
                <Sparkles size={17} />
              </div>
              {currentBrief ? (
                <div className="sm-beginner-session-brief-summary">
                  <strong>{currentBrief.goal}</strong>
                  <span>{t(`session.brief.${currentBrief.approval}`)}</span>
                </div>
              ) : (
                <p className="sm-beginner-muted-copy">{t('session.noBrief')}</p>
              )}
              <div className="sm-beginner-session-facts">
                <div><span>{t('session.questionCount')}</span><strong>{session.openQuestions.filter((q) => q.status === 'open').length}</strong></div>
                <div><span>{t('session.decisionCount')}</span><strong>{projectControl.decisions.length}</strong></div>
                <div><span>{t('session.artifactCount')}</span><strong>{projectControl.briefs.length}</strong></div>
              </div>
            </section>

            {currentBrief && (
              <section className="sm-beginner-session-brief-card">
                <div className="sm-beginner-session-card-heading">
                  <div>
                    <p className="sm-beginner-eyebrow">{t('session.briefEyebrow')}</p>
                    <h2>{t('session.briefTitle')}</h2>
                  </div>
                  <FileText size={17} />
                </div>
                <BriefList label={t('session.brief.users')} items={currentBrief.users} />
                <BriefList label={t('session.brief.scope')} items={currentBrief.scope} />
                <BriefList label={t('session.brief.nonGoals')} items={currentBrief.nonGoals} />
                <BriefList label={t('session.brief.constraints')} items={currentBrief.constraints} />
                <BriefList label={t('session.brief.acceptance')} items={currentBrief.acceptanceCriteria} />
                <BriefList label={t('session.brief.assumptions')} items={currentBrief.assumptions} />
                {currentBrief.approval === 'draft' ? (
                  <button type="button" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onApproveBrief}>
                    <CheckCircle2 size={16} /> {t('session.approveBrief')}
                  </button>
                ) : (
                  <p className="sm-beginner-session-approved"><CheckCircle2 size={15} /> {t('session.briefApproved')}</p>
                )}
              </section>
            )}

            {currentArchitecture && (
              <section className="sm-beginner-session-architecture-card">
                <div className="sm-beginner-session-card-heading">
                  <div>
                    <p className="sm-beginner-eyebrow">{t('session.architectureEyebrow')}</p>
                    <h2>{t('session.architectureTitle')}</h2>
                  </div>
                  <Sparkles size={17} />
                </div>
                <p className="sm-beginner-session-architecture-overview">{currentArchitecture.overview}</p>
                <ArchitectureItems label={t('session.architecture.modules')} items={currentArchitecture.modules.map((module) => `${module.name}：${module.responsibility}`)} />
                <ArchitectureItems label={t('session.architecture.interfaces')} items={currentArchitecture.interfaces.map((item) => `${item.name}：${item.description}`)} />
                <ArchitectureItems label={t('session.architecture.tasks')} items={currentArchitecture.tasks.map((task) => task.title)} />
                <ArchitectureItems label={t('session.architecture.risks')} items={currentArchitecture.risks} />
                {currentArchitecture.approval === 'draft' ? (
                  <button type="button" data-testid="beginner-session-approve-architecture" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onApproveArchitecture}>
                    <CheckCircle2 size={16} /> {t('session.approveArchitecture')}
                  </button>
                ) : (
                  <p className="sm-beginner-session-approved"><CheckCircle2 size={15} /> {t('session.architectureApproved')}</p>
                )}
              </section>
            )}

            {currentTaskGraph && (
              <section className="sm-beginner-session-task-card">
                <div className="sm-beginner-session-card-heading">
                  <div>
                    <p className="sm-beginner-eyebrow">{t('session.taskGraphEyebrow')}</p>
                    <h2>{t('session.taskGraphTitle')}</h2>
                  </div>
                  <ClipboardList size={17} />
                </div>
                <ArchitectureItems label={t('session.taskGraph.tasks')} items={currentTaskGraph.tasks.map((task) => `${task.title}：${task.scope.join('、') || '待补充影响范围'}`)} />
                {currentTaskGraph.approval === 'draft' ? (
                  <button type="button" data-testid="beginner-session-approve-task-graph" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={onApproveTaskGraph}>
                    <CheckCircle2 size={16} /> {t('session.approveTaskGraph')}
                  </button>
                ) : (
                  <p className="sm-beginner-session-approved"><CheckCircle2 size={15} /> {t('session.taskGraphApproved')}</p>
                )}
              </section>
            )}

            <section className="sm-beginner-session-next-card">
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
              {currentWorkerRunRecovery && (
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
              )}
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
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="sm-beginner-session-brief-list">
      <span>{label}</span>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function ArchitectureItems({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="sm-beginner-session-brief-list">
      <span>{label}</span>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
