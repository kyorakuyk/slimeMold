import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import {
  applyMasterTurnCommand,
  approveArchitectureCommand,
  approveBriefCommand,
  approveTaskGraphCommand,
  createExecutionDraftCreatedEvent,
  generateTaskGraphCommand,
  linkOrchestrationCommand,
} from '../projectControl/commands';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import { resolveMasterAgent, runMasterTurn, type MasterResponse } from '../projectControl/master';
import { buildExecutionDraftFromTaskGraph } from '../projectControl/executionPlan';
import { confirmDraft, createOrchestration } from '../orchestrator/confirm';
import { buildConstructionWorkflow, buildOpsWorkflow } from '../engine/builder';
import type { ProjectControlSnapshot, ProjectSession } from '../projectControl/types';

interface ProjectSessionPanelProps {
  sessionId: string;
  onBackHome: () => void;
  onOpenAdvanced: () => void;
  onOpenIssues?: () => void;
  onOpenMasterAgent?: () => void;
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
}: ProjectSessionPanelProps) {
  const t = useT('beginner');
  const projectName = useWorkflowStore((state) => state.projectName);
  const projectDirty = useWorkflowStore((state) => state.projectDirty);
  const orchestrations = useWorkflowStore((state) => state.orchestrations);
  const projectControl = useWorkflowStore((state) => state.projectControl);
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
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [localResponse, setLocalResponse] = useState<MasterResponse | null>(null);
  const initialTurnStarted = useRef(false);

  const visibleQuestions = useMemo(
    () => (session ? responseQuestions(session, localResponse) : []),
    [session, localResponse],
  );
  const localReplyVisible = !!localResponse &&
    !!session && !session.messages.some((message) => message.content === localResponse.reply);

  const runTurn = async (userMessage: string, recordUserMessage: boolean) => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    if (!currentSession) {
      setError(t('session.error.noSession'));
      return;
    }

    setBusy(true);
    setError(null);
    setStreamingText('');
    try {
      const agent = resolveMasterAgent({
        agents: state.agents,
        globalAgents: state.globalAgents,
        requestedAgentId: state.projectControl.masterAgentId,
        globalMasterAgentId,
        defaultAgentId: state.defaultAgentId,
      });
      const brief = currentSession.briefId
        ? snapshot.briefs.find((item) => item.id === currentSession.briefId) ?? null
        : null;
      const result = await runMasterTurn({
        agent,
        session: currentSession,
        userMessage,
        currentBrief: brief,
        decisions: snapshot.decisions,
        onToken: (text) => setStreamingText((current) => current + text),
      });
      const latestSnapshot = useWorkflowStore.getState().projectControl;
      const next = applyMasterTurnCommand({
        snapshot: latestSnapshot,
        sessionId,
        userMessage: recordUserMessage ? userMessage : undefined,
        response: result.response,
        now: new Date().toISOString(),
        createId: controlId,
      });
      recordProjectEvents(currentSession.projectId, next.events);
      useWorkflowStore.getState().setProjectControl(next.snapshot);
      setLocalResponse(result.response);
      if (recordUserMessage) setInput('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setStreamingText('');
    }
  };

  useEffect(() => {
    if (!session || initialTurnStarted.current) return;
    if (session.messages.some((message) => message.role === 'assistant') || session.briefId) return;
    initialTurnStarted.current = true;
    void runTurn('请开始需求澄清，先提出最关键的问题。', false);
    // 只在这个会话第一次挂载时触发，后续状态更新不能重复发起主控调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.id]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    void runTurn(message, true);
  };

  const handleApproveBrief = () => {
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
      recordProjectEvents(currentSession.projectId, next.events);
      state.setProjectControl(next.snapshot);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleGenerateArchitecture = () => {
    if (!currentBrief || currentBrief.approval !== 'approved' || currentArchitecture || busy) return;
    void runTurn('请基于已批准的 Brief 生成架构、模块、接口、施工任务和风险。', false);
  };

  const handleApproveArchitecture = () => {
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
      recordProjectEvents(currentSession.projectId, next.events);
      state.setProjectControl(next.snapshot);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleGenerateTaskGraph = () => {
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
      recordProjectEvents(currentSession.projectId, next.events);
      state.setProjectControl(next.snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApproveTaskGraph = () => {
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
      recordProjectEvents(currentSession.projectId, next.events);
      state.setProjectControl(next.snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCreateOrchestration = () => {
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
      recordProjectEvents(currentSession.projectId, [
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
      state.setProjectControl(next.snapshot);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleConfirmExecutionPlan = () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const orchestrationId = currentSession?.orchestrationId;
    const orchestration = orchestrationId
      ? state.orchestrations.find((item) => item.id === orchestrationId)
      : undefined;
    if (!currentSession || !orchestration || orchestration.status !== 'awaiting-confirm') return;
    try {
      const now = new Date().toISOString();
      const approved = confirmDraft(orchestration.id, 'approved');
      recordProjectEvents(currentSession.projectId, [{
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
      }]);
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
            <p>{t(sessionStatusKey(session.status))}</p>
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

            <form className="sm-beginner-session-composer" onSubmit={handleSubmit}>
              <label htmlFor="project-session-input">{t('session.replyLabel')}</label>
              <textarea
                id="project-session-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
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
                  <button type="button" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleApproveBrief}>
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
                  <button type="button" data-testid="beginner-session-approve-architecture" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleApproveArchitecture}>
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
                  <button type="button" data-testid="beginner-session-approve-task-graph" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleApproveTaskGraph}>
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
                {currentOrchestration?.status === 'awaiting-confirm'
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
                {currentOrchestration?.status === 'awaiting-confirm'
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
              {currentBrief?.approval === 'approved' && !currentArchitecture && (
                <button type="button" data-testid="beginner-session-generate-architecture" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleGenerateArchitecture} disabled={busy}>
                  {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <Sparkles size={16} />}
                  {busy ? t('session.thinking') : t('session.generateArchitecture')}
                </button>
              )}
              {currentTaskGraph?.approval === 'approved' && !currentOrchestration && (
                <button type="button" data-testid="beginner-session-generate-orchestration" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleCreateOrchestration} disabled={busy}>
                  <Wrench size={16} /> {t('session.generateOrchestration')}
                </button>
              )}
              {currentArchitecture?.approval === 'approved' && !currentTaskGraph && (
                <button type="button" data-testid="beginner-session-generate-task-graph" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleGenerateTaskGraph} disabled={busy}>
                  {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <ClipboardList size={16} />}
                  {t('session.generateTaskGraph')}
                </button>
              )}
              {currentOrchestration?.status === 'awaiting-confirm' && (
                <button type="button" data-testid="beginner-session-confirm-execution-plan" className="sm-beginner-primary-button sm-beginner-session-approve" onClick={handleConfirmExecutionPlan}>
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
