import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  FileBox,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { runWorkflow, stopWorkflow } from '../engine/executor';
import {
  clearRecentProjects,
  getRecentProjects,
  openProjectByPath,
  openProjectFile,
  pushRecentProject,
  removeRecentProject,
  saveLastSession,
  type RecentProject,
} from '../io/projectIO';
import type { RunRecord } from '../types';
import { useT } from '../i18n/useT';
import slimeMoldIcon from '../assets/slimemold-dense-ic-state.svg';

interface BeginnerExperienceProps {
  onOpenAdvanced: () => void;
  onNewProject: () => void;
}

type BeginnerPage = 'home' | 'project';
type StatusTone = 'ready' | 'running' | 'attention' | 'paused' | 'unsaved';

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function getRunLabel(t: (key: string) => string, status: RunRecord['status']): string {
  if (status === 'success') return t('project.latest.success');
  if (status === 'error') return t('project.latest.failed');
  return t('project.latest.aborted');
}

function RunIcon({ status }: { status: RunRecord['status'] }) {
  if (status === 'success') return <CheckCircle2 size={17} />;
  if (status === 'error') return <XCircle size={17} />;
  return <CircleDashed size={17} />;
}

function SimpleHeader({
  onOpenAdvanced,
  onBackHome,
}: {
  onOpenAdvanced: () => void;
  onBackHome?: () => void;
}) {
  const t = useT('beginner');
  return (
    <header className="sm-beginner-nav">
      <div className="sm-beginner-nav-inner">
        <button
          type="button"
          className="sm-beginner-brand"
          onClick={onBackHome}
          disabled={!onBackHome}
          aria-label={t('project.back')}
        >
          {onBackHome && <ArrowLeft size={15} aria-hidden="true" />}
          <img
            className="sm-beginner-logo"
            src={slimeMoldIcon}
            alt=""
            aria-hidden="true"
          />
          <span className="sm-beginner-brand-name">{t('brand')}</span>
          <span className="sm-beginner-mode">{t('mode')}</span>
        </button>

        <div className="sm-beginner-nav-actions">
          <span className="sm-beginner-local-pill">
            <span className="sm-beginner-local-dot" aria-hidden="true" />
            {t('local')}
          </span>
          <button type="button" className="sm-beginner-nav-link" onClick={onOpenAdvanced}>
            <LayoutDashboard size={15} aria-hidden="true" />
            {t('advanced')}
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

export default function BeginnerExperience({ onOpenAdvanced, onNewProject }: BeginnerExperienceProps) {
  const projectId = useWorkflowStore((s) => s.projectId);
  const [page, setPage] = useState<BeginnerPage>(() => (projectId ? 'project' : 'home'));

  useEffect(() => {
    setPage(projectId ? 'project' : 'home');
  }, [projectId]);

  if (page === 'project' && projectId) {
    return (
      <ProjectCockpit
        onOpenAdvanced={onOpenAdvanced}
        onBackHome={() => setPage('home')}
      />
    );
  }

  return (
    <WorkspaceHome
      onOpenAdvanced={onOpenAdvanced}
      onNewProject={onNewProject}
      onProjectOpened={() => setPage('project')}
    />
  );
}

function WorkspaceHome({
  onOpenAdvanced,
  onNewProject,
  onProjectOpened,
}: {
  onOpenAdvanced: () => void;
  onNewProject: () => void;
  onProjectOpened: () => void;
}) {
  const t = useT('beginner');
  const [recents, setRecents] = useState<RecentProject[]>(() => getRecentProjects());
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openLoadedProject = (file: Awaited<ReturnType<typeof openProjectByPath>>, path: string) => {
    if (!file) return false;
    if (!useWorkflowStore.getState().openProject(file, path)) {
      setError(t('home.openFailed', { message: t('home.invalidProject') }));
      return false;
    }
    const state = useWorkflowStore.getState();
    pushRecentProject({ name: file.name, path, openedAt: new Date().toISOString() });
    saveLastSession({ path, activeId: state.activeWfId || undefined });
    setRecents(getRecentProjects());
    // 即使打开的是当前已恢复的同一个项目，projectId 也不会变化；显式切到驾驶舱。
    onProjectOpened();
    return true;
  };

  const handleOpen = async () => {
    setLoading('open');
    setError(null);
    try {
      const file = await openProjectFile();
      if (file) openLoadedProject(file, file.path);
    } catch (e) {
      setError(t('home.openFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(null);
    }
  };

  const handleRecent = async (project: RecentProject) => {
    setLoading(project.path);
    setError(null);
    try {
      const file = await openProjectByPath(project.path);
      if (!file) {
        removeRecentProject(project.path);
        setRecents(getRecentProjects());
        setError(t('home.projectUnavailable', { path: project.path }));
        return;
      }
      if (!openLoadedProject(file, file.path || project.path)) {
        removeRecentProject(project.path);
        setRecents(getRecentProjects());
      }
    } catch (e) {
      setError(t('home.openFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="sm-beginner-shell">
      <SimpleHeader onOpenAdvanced={onOpenAdvanced} />
      <main className="sm-beginner-main">
        <section className="sm-beginner-home-hero" aria-labelledby="beginner-home-title">
          <div className="sm-beginner-hero-copy">
            <p className="sm-beginner-eyebrow">
              <span className="sm-beginner-eyebrow-mark" aria-hidden="true" />
              {t('home.eyebrow')}
            </p>
            <h1 id="beginner-home-title">
              {t('home.titleLine1')}
              <br />
              <span>{t('home.titleLine2')}</span>
            </h1>
            <p className="sm-beginner-lede">{t('home.subtitle')}</p>
            <div className="sm-beginner-action-row">
              <button type="button" className="sm-beginner-primary-button" onClick={onNewProject}>
                <FolderPlus size={17} aria-hidden="true" />
                {t('home.newProject')}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="sm-beginner-secondary-button"
                onClick={handleOpen}
                disabled={loading !== null}
              >
                <FolderOpen size={17} aria-hidden="true" />
                {loading === 'open' ? t('home.opening') : t('home.openProject')}
              </button>
            </div>
            <p className="sm-beginner-trust-note">
              <ShieldCheck size={15} aria-hidden="true" />
              {t('home.localNote')}
            </p>
            {error && <p className="sm-beginner-inline-error" role="alert">{error}</p>}
          </div>

          <div className="sm-beginner-hero-art" aria-label={t('home.howTitle')}>
            <div className="sm-beginner-art-glow" aria-hidden="true" />
            <div className="sm-beginner-process-card">
              <div className="sm-beginner-process-topline">
                <span className="sm-beginner-process-label">SlimeMold</span>
                <span className="sm-beginner-process-status"><span /> {t('local')}</span>
              </div>
              <div className="sm-beginner-process-title">{t('home.howTitle')}</div>
              <div className="sm-beginner-process-line" aria-hidden="true" />
              <div className="sm-beginner-process-step is-done">
                <span className="sm-beginner-process-icon"><CheckCircle2 size={15} /></span>
                <span>{t('home.step1Title')}</span>
                <span className="sm-beginner-process-tail">01</span>
              </div>
              <div className="sm-beginner-process-step is-next">
                <span className="sm-beginner-process-icon"><Sparkles size={15} /></span>
                <span>{t('home.step2Title')}</span>
                <span className="sm-beginner-process-tail">02</span>
              </div>
              <div className="sm-beginner-process-step">
                <span className="sm-beginner-process-icon"><ShieldCheck size={15} /></span>
                <span>{t('home.step3Title')}</span>
                <span className="sm-beginner-process-tail">03</span>
              </div>
            </div>
            <div className="sm-beginner-art-caption">
              <Activity size={14} aria-hidden="true" />
              <span>{t('home.localNote')}</span>
            </div>
          </div>
        </section>

        <section className="sm-beginner-home-grid">
          <div className="sm-beginner-section-block">
            <div className="sm-beginner-section-heading">
              <div>
                <p className="sm-beginner-eyebrow">{t('home.recentEyebrow')}</p>
                <h2>{t('home.recentTitle')}</h2>
              </div>
              {recents.length > 0 && (
                <button
                  type="button"
                  className="sm-beginner-text-button"
                  onClick={() => {
                    clearRecentProjects();
                    setRecents([]);
                  }}
                >
                  {t('home.clearRecent')}
                </button>
              )}
            </div>
            <p className="sm-beginner-section-subtitle">{t('home.recentSubtitle')}</p>
            {recents.length === 0 ? (
              <div className="sm-beginner-empty-projects">
                <div className="sm-beginner-empty-icon"><FolderOpen size={20} /></div>
                <div>
                  <strong>{t('home.noRecent')}</strong>
                  <p>{t('home.noRecentHint')}</p>
                </div>
                <button type="button" className="sm-beginner-small-button" onClick={onNewProject}>
                  {t('home.newFirst')} <ArrowRight size={14} />
                </button>
              </div>
            ) : (
              <div className="sm-beginner-recent-list">
                {recents.slice(0, 6).map((project) => (
                  <button
                    type="button"
                    key={project.path}
                    className="sm-beginner-recent-row"
                    onClick={() => handleRecent(project)}
                    disabled={loading !== null}
                  >
                    <span className="sm-beginner-recent-icon"><FolderOpen size={17} /></span>
                    <span className="sm-beginner-recent-copy">
                      <strong>{project.name}</strong>
                      <span>{project.path}</span>
                    </span>
                    <span className="sm-beginner-recent-date">
                      {loading === project.path ? t('home.opening') : formatDate(project.openedAt)}
                    </span>
                    <ChevronRight size={16} className="sm-beginner-row-chevron" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="sm-beginner-how-card">
            <p className="sm-beginner-eyebrow">{t('home.howEyebrow')}</p>
            <h2>{t('home.howTitle')}</h2>
            <div className="sm-beginner-step-list">
              <BeginnerStep number="01" title={t('home.step1Title')} body={t('home.step1Body')} />
              <BeginnerStep number="02" title={t('home.step2Title')} body={t('home.step2Body')} />
              <BeginnerStep number="03" title={t('home.step3Title')} body={t('home.step3Body')} />
            </div>
          </div>
        </section>

        <div className="sm-beginner-advanced-strip">
          <div>
            <span className="sm-beginner-strip-icon"><GitBranch size={16} /></span>
            <span>
              <strong>{t('home.advancedHint')}</strong>
              <small>{t('project.advanced.body')}</small>
            </span>
          </div>
          <button type="button" className="sm-beginner-text-button" onClick={onOpenAdvanced}>
            {t('home.openAdvanced')} <ArrowUpRight size={14} />
          </button>
        </div>
      </main>
    </div>
  );
}

function BeginnerStep({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="sm-beginner-step">
      <span className="sm-beginner-step-number">{number}</span>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
    </div>
  );
}

function ProjectCockpit({
  onOpenAdvanced,
  onBackHome,
}: {
  onOpenAdvanced: () => void;
  onBackHome: () => void;
}) {
  const t = useT('beginner');
  const projectName = useWorkflowStore((s) => s.projectName);
  const projectPath = useWorkflowStore((s) => s.projectPath);
  const projectDirty = useWorkflowStore((s) => s.projectDirty);
  const workflows = useWorkflowStore((s) => s.workflows);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const nodes = useWorkflowStore((s) => s.nodes);
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const running = useWorkflowStore((s) => s.running);
  const runProgress = useWorkflowStore((s) => s.runProgress);
  const runStates = useWorkflowStore((s) => s.runStates);
  const artifacts = useWorkflowStore((s) => s.artifacts);
  const switchWorkflow = useWorkflowStore((s) => s.switchWorkflow);

  const workflowEntries = useMemo(() => Object.entries(workflows), [workflows]);
  const latestRun = runHistory[0] ?? null;
  const totalNodes = useMemo(
    () => workflowEntries.reduce((sum, [, workflow]) => sum + workflow.nodes.length, 0),
    [workflowEntries],
  );
  const artifactCount = useMemo(
    () => Object.values(artifacts).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0),
    [artifacts],
  );
  const activeProgress = runStates[activeWfId]?.progress ?? runProgress;
  const status = getProjectStatus(running, projectDirty, latestRun, nodes);
  const statusLabel = t(`project.${status.tone}`);
  const statusHint = t(`project.status.${status.tone}Hint`);
  const progressPercent = activeProgress.totalLayers > 0
    ? Math.min(100, Math.max(8, Math.round((activeProgress.layer / activeProgress.totalLayers) * 100)))
    : 8;

  const handleRun = () => {
    if (!activeWfId) return;
    if (running) stopWorkflow(activeWfId);
    else void runWorkflow({ wfId: activeWfId });
  };

  const nextAction = latestRun?.status === 'success'
    ? { title: t('project.next.done'), hint: t('project.next.doneHint'), action: onOpenAdvanced }
    : latestRun
      ? { title: t('project.next.review'), hint: t('project.next.reviewHint'), action: onOpenAdvanced }
      : { title: t('project.next.run'), hint: t('project.next.runHint'), action: handleRun };

  return (
    <div className="sm-beginner-shell">
      <SimpleHeader onOpenAdvanced={onOpenAdvanced} onBackHome={onBackHome} />
      <main className="sm-beginner-main sm-beginner-project-main">
        <div className="sm-beginner-project-topline">
          <button type="button" className="sm-beginner-back-link" onClick={onBackHome}>
            <ArrowLeft size={14} /> {t('project.back')}
          </button>
          <span className="sm-beginner-project-path">{projectPath || t('project.local')}</span>
        </div>

        <section className="sm-beginner-project-hero" aria-labelledby="beginner-project-title">
          <div className="sm-beginner-project-heading">
            <div className="sm-beginner-project-mark" aria-hidden="true">
              <Workflow size={24} />
            </div>
            <div>
              <p className="sm-beginner-eyebrow">{t('project.eyebrow')}</p>
              <h1 id="beginner-project-title">{projectName || t('project.local')}</h1>
              <p>{projectPath || t('project.local')}</p>
            </div>
          </div>
          <div className="sm-beginner-project-actions">
            <button type="button" className="sm-beginner-secondary-button" onClick={onOpenAdvanced}>
              <GitBranch size={16} /> {t('project.openAdvanced')}
            </button>
            <button
              type="button"
              className="sm-beginner-primary-button"
              onClick={handleRun}
              disabled={!activeWfId}
            >
              {running ? <Square size={16} /> : <Play size={16} />}
              {running ? t('project.stop') : t('project.run')}
              {!running && <ArrowRight size={15} />}
            </button>
          </div>
        </section>

        <section className="sm-beginner-status-card">
          <div className={`sm-beginner-status-mark is-${status.tone}`}>
            {status.tone === 'running' ? <Loader2 size={18} className="sm-beginner-spin" /> : status.tone === 'attention' ? <TriangleAlert size={18} /> : status.tone === 'paused' ? <CircleDashed size={18} /> : <CheckCircle2 size={18} />}
          </div>
          <div className="sm-beginner-status-copy">
            <strong>{statusLabel}</strong>
            <span>{statusHint}</span>
          </div>
          {running && (
            <div className="sm-beginner-progress-wrap">
              <div className="sm-beginner-progress-meta">
                <span>{t('project.progress.title')}</span>
                <span>{t('project.progress.layer', { layer: activeProgress.layer, total: activeProgress.totalLayers || '—' })}</span>
              </div>
              <div className="sm-beginner-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
            </div>
          )}
        </section>

        <section className="sm-beginner-stat-grid" aria-label="Project summary">
          <BeginnerStat icon={<Workflow size={17} />} value={workflowEntries.length} label={t('project.stats.workflow')} />
          <BeginnerStat icon={<GitBranch size={17} />} value={totalNodes} label={t('project.stats.nodes')} />
          <BeginnerStat icon={<FileBox size={17} />} value={artifactCount} label={t('project.stats.artifacts')} />
          <BeginnerStat icon={<RefreshCw size={17} />} value={runHistory.length} label={t('project.stats.runs')} />
        </section>

        <section className="sm-beginner-next-card">
          <div className="sm-beginner-next-icon"><Sparkles size={19} /></div>
          <div className="sm-beginner-next-copy">
            <p className="sm-beginner-eyebrow">{t('project.next.title')}</p>
            <strong>{nextAction.title}</strong>
            <span>{nextAction.hint}</span>
          </div>
          <button type="button" className="sm-beginner-small-button" onClick={nextAction.action} disabled={running && !latestRun}>
            {latestRun?.status === 'success' ? t('project.advanced.open') : nextAction.title}
            <ArrowRight size={14} />
          </button>
        </section>

        <section className="sm-beginner-project-grid">
          <WorkflowList
            entries={workflowEntries}
            activeWfId={activeWfId}
            runStates={runStates}
            onSwitch={switchWorkflow}
            t={t}
          />
          <LatestRun run={latestRun} t={t} />
        </section>

        <section className="sm-beginner-activity-card">
          <div className="sm-beginner-section-heading">
            <div>
              <p className="sm-beginner-eyebrow">{t('project.activity.title')}</p>
              <h2>{t('project.activity.title')}</h2>
            </div>
            <Clock3 size={17} aria-hidden="true" />
          </div>
          {runHistory.length === 0 ? (
            <p className="sm-beginner-muted-copy">{t('project.activity.empty')}</p>
          ) : (
            <div className="sm-beginner-activity-list">
              {runHistory.slice(0, 5).map((run) => (
                <div className="sm-beginner-activity-row" key={run.id}>
                  <span className={`sm-beginner-activity-icon is-${run.status}`}><RunIcon status={run.status} /></span>
                  <span className="sm-beginner-activity-copy">
                    <strong>{run.name || getRunLabel(t, run.status)}</strong>
                    <small>{formatDate(run.startedAt)}</small>
                  </span>
                  <span className={`sm-beginner-activity-status is-${run.status}`}>
                    {run.status === 'success' ? t('project.activity.success') : run.status === 'error' ? t('project.activity.failed') : t('project.activity.aborted')}
                  </span>
                  <span className="sm-beginner-activity-meta">{t('project.activity.nodes', { count: run.nodeCount })}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="sm-beginner-advanced-strip">
          <div>
            <span className="sm-beginner-strip-icon"><GitBranch size={16} /></span>
            <span>
              <strong>{t('project.advanced.title')}</strong>
              <small>{t('project.advanced.body')}</small>
            </span>
          </div>
          <button type="button" className="sm-beginner-text-button" onClick={onOpenAdvanced}>
            {t('project.advanced.open')} <ArrowUpRight size={14} />
          </button>
        </div>
      </main>
    </div>
  );
}

function BeginnerStat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="sm-beginner-stat">
      <span className="sm-beginner-stat-icon">{icon}</span>
      <span className="sm-beginner-stat-value">{formatNumber(value)}</span>
      <span className="sm-beginner-stat-label">{label}</span>
    </div>
  );
}

function WorkflowList({
  entries,
  activeWfId,
  runStates,
  onSwitch,
  t,
}: {
  entries: [string, { name: string; nodes: Array<{ data: { status: string } }>; edges: unknown[] }][];
  activeWfId: string;
  runStates: Record<string, { running: boolean }>;
  onSwitch: (id: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <section className="sm-beginner-panel-card">
      <div className="sm-beginner-card-heading">
        <div>
          <p className="sm-beginner-eyebrow">{t('project.workflows.title')}</p>
          <h2>{t('project.workflows.title')}</h2>
        </div>
        <span className="sm-beginner-card-count">{t('project.workflows.count', { count: entries.length })}</span>
      </div>
      {entries.length === 0 ? (
        <p className="sm-beginner-muted-copy">{t('home.noRecentHint')}</p>
      ) : (
        <div className="sm-beginner-workflow-list">
          {entries.map(([id, workflow]) => {
            const active = id === activeWfId;
            const isRunning = runStates[id]?.running ?? false;
            const hasError = workflow.nodes.some((node) => node.data.status === 'error');
            const hasSuccess = workflow.nodes.some((node) => node.data.status === 'success');
            return (
              <button
                type="button"
                key={id}
                className={`sm-beginner-workflow-row${active ? ' is-active' : ''}`}
                onClick={() => onSwitch(id)}
              >
                <span className={`sm-beginner-workflow-dot ${isRunning ? 'is-running' : hasError ? 'is-error' : hasSuccess ? 'is-success' : ''}`} />
                <span className="sm-beginner-workflow-copy">
                  <strong>{workflow.name}</strong>
                  <small>{t('project.workflow.nodes', { count: workflow.nodes.length })} · {t('project.workflow.edges', { count: workflow.edges.length })}</small>
                </span>
                {active && <span className="sm-beginner-active-badge">{t('project.workflow.active')}</span>}
                {!active && <span className="sm-beginner-workflow-switch">{t('project.workflow.switch')} <ChevronRight size={14} /></span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LatestRun({
  run,
  t,
}: {
  run: RunRecord | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <section className="sm-beginner-panel-card">
      <div className="sm-beginner-card-heading">
        <div>
          <p className="sm-beginner-eyebrow">{t('project.latest.title')}</p>
          <h2>{t('project.latest.title')}</h2>
        </div>
        {run && <RunIcon status={run.status} />}
      </div>
      {!run ? (
        <div className="sm-beginner-run-empty">
          <span className="sm-beginner-run-empty-icon"><CircleDashed size={20} /></span>
          <strong>{t('project.latest.empty')}</strong>
          <p>{t('project.latest.emptyHint')}</p>
        </div>
      ) : (
        <div className="sm-beginner-latest-run">
          <div className={`sm-beginner-run-status is-${run.status}`}>
            <RunIcon status={run.status} />
            <strong>{getRunLabel(t, run.status)}</strong>
          </div>
          <span className="sm-beginner-run-time">{formatDate(run.endedAt || run.startedAt)}</span>
          <div className="sm-beginner-run-details">
            <span>{t('project.latest.duration', { value: formatDuration(run.durationMs) })}</span>
            <span>{t('project.latest.nodes', { count: run.nodeCount })}</span>
            {run.cost && <span>{t('project.latest.tokens', { count: formatNumber(run.cost.totalTokens) })}</span>}
          </div>
          {run.note && <p className="sm-beginner-run-note">{run.note}</p>}
        </div>
      )}
    </section>
  );
}

function getProjectStatus(
  running: boolean,
  dirty: boolean,
  latestRun: RunRecord | null,
  nodes: Array<{ data: { status: string } }>,
): { tone: StatusTone } {
  if (running) return { tone: 'running' };
  if (latestRun?.status === 'error' || nodes.some((node) => node.data.status === 'error')) {
    return { tone: 'attention' };
  }
  if (latestRun?.status === 'aborted') return { tone: 'paused' };
  if (dirty) return { tone: 'unsaved' };
  return { tone: 'ready' };
}
