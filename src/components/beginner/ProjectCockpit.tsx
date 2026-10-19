import { useMemo } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ClipboardList,
  ChevronRight,
  CircleDashed,
  Clock3,
  FileBox,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useWorkflowStore } from '../../store/workflowStore';
import { runWorkflow, stopWorkflow } from '../../engine/executor';
import type { RunRecord } from '../../types/execution';
import { useT } from '../../i18n/useT';
import { formatDate, SimpleHeader } from './BeginnerHeader';

type StatusTone = 'ready' | 'running' | 'attention' | 'paused' | 'unsaved';

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

/** 新手项目驾驶舱：把当前工作流、最近运行与进度压缩成项目概况和下一步入口。
 * 运行/停止复用既有 workflow actions，不在页面另存一份执行状态（ADR-SM-004、ADR-SM-075）。
 */
export default function ProjectCockpit({
  onOpenAdvanced,
  onOpenIssues,
  onOpenMasterAgent,
  onBackHome,
}: {
  onOpenAdvanced: () => void;
  onOpenIssues?: () => void;
  onOpenMasterAgent?: () => void;
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
            {onOpenMasterAgent && (
              <button type="button" className="sm-beginner-text-button" onClick={onOpenMasterAgent}>
                <Bot size={16} /> {t('project.openMasterAgent')}
              </button>
            )}
            {onOpenIssues && (
              <button type="button" className="sm-beginner-text-button" onClick={onOpenIssues}>
                <ClipboardList size={16} /> {t('project.openIssues')}
              </button>
            )}
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
