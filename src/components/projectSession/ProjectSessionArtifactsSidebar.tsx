import { CheckCircle2, ClipboardList, FileText, Sparkles } from 'lucide-react';
import type {
  ProjectSessionPanelViewProps,
  ProjectSessionViewTranslator,
} from './ProjectSessionPanelView.types';

type ProjectSessionArtifactsSidebarProps = Pick<
  ProjectSessionPanelViewProps,
  | 'projectControl'
  | 'session'
  | 'currentBrief'
  | 'currentArchitecture'
  | 'currentTaskGraph'
  | 'onApproveBrief'
  | 'onApproveArchitecture'
  | 'onApproveTaskGraph'
> & { t: ProjectSessionViewTranslator };

export default function ProjectSessionArtifactsSidebar({
  projectControl,
  session,
  currentBrief,
  currentArchitecture,
  currentTaskGraph,
  onApproveBrief,
  onApproveArchitecture,
  onApproveTaskGraph,
  t,
}: ProjectSessionArtifactsSidebarProps) {
  return (
    <>
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
    </>
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
