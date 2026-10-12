import { useState } from 'react';
import { Activity, ArrowRight, CheckCircle2, ChevronRight, FolderOpen, FolderPlus, ShieldCheck, Sparkles } from 'lucide-react';
import { useWorkflowStore } from '../../store/workflowStore';
import {
  clearRecentProjects,
  getRecentProjects,
  openProjectByPath,
  openProjectFile,
  pushRecentProject,
  removeRecentProject,
  saveLastSession,
} from '../../io/projectIO';
import type { RecentProject } from '../../types/project';
import { useT } from '../../i18n/useT';
import { formatDate, SimpleHeader } from './BeginnerHeader';

export default function WorkspaceHome({
  onNewProject,
  onStartProjectSession,
  onProjectOpened,
}: {
  onNewProject: () => void;
  onStartProjectSession: (goal: string) => void;
  onProjectOpened: () => void;
}) {
  const t = useT('beginner');
  const [recents, setRecents] = useState<RecentProject[]>(() => getRecentProjects());
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');

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
      <SimpleHeader />
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
            <div className="sm-beginner-goal-box">
              <label htmlFor="beginner-project-goal">{t('home.goalLabel')}</label>
              <textarea
                id="beginner-project-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t('home.goalPlaceholder')}
                rows={3}
              />
              <button
                type="button"
                className="sm-beginner-primary-button"
                onClick={() => {
                  const value = goal.trim();
                  if (!value) return;
                  onStartProjectSession(value);
                }}
                disabled={!goal.trim()}
              >
                <Sparkles size={17} aria-hidden="true" />
                {t('home.startSession')}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="sm-beginner-action-row">
              <button
                type="button"
                className="sm-beginner-secondary-button"
                onClick={handleOpen}
                disabled={loading !== null}
              >
                <FolderOpen size={17} aria-hidden="true" />
                {loading === 'open' ? t('home.opening') : t('home.openProject')}
              </button>
              <button type="button" className="sm-beginner-text-button" onClick={onNewProject}>
                <FolderPlus size={15} aria-hidden="true" /> {t('home.newProject')}
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
