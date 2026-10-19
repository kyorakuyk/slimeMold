import { ArrowLeft, ArrowRight, MessageCircle } from 'lucide-react';
import type {
  ProjectSessionPanelViewProps,
  ProjectSessionViewTranslator,
} from './ProjectSessionPanelView.types';

type ProjectSessionTopSectionProps = Pick<
  ProjectSessionPanelViewProps,
  | 'projectDirty'
  | 'onBackHome'
  | 'onOpenMasterAgent'
  | 'onOpenIssues'
  | 'currentWorkerRun'
  | 'currentWorkerRunRecovery'
  | 'canRunWorker'
  | 'workerRuntime'
  | 'workerStartBusy'
  | 'onWorkerRuntimeChange'
  | 'onStartQueuedWorker'
  | 'onOpenAdvanced'
  | 'projectName'
  | 'sessionStatusLabel'
> & { t: ProjectSessionViewTranslator };

export default function ProjectSessionTopSection({
  projectDirty,
  onBackHome,
  onOpenMasterAgent,
  onOpenIssues,
  currentWorkerRun,
  currentWorkerRunRecovery,
  canRunWorker,
  workerRuntime,
  workerStartBusy,
  onWorkerRuntimeChange,
  onStartQueuedWorker,
  onOpenAdvanced,
  projectName,
  sessionStatusLabel,
  t,
}: ProjectSessionTopSectionProps) {
  return (
    <>
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
                  onChange={(event) => onWorkerRuntimeChange(event.target.value as typeof workerRuntime)}
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
    </>
  );
}
