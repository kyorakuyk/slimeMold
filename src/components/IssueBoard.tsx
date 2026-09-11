import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CircleDashed,
  ClipboardList,
  Inbox,
  Plus,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import { createIssue } from '../projectControl/issue';
import { transitionIssueCommand } from '../projectControl/commands';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import {
  buildTaskGraphProjection,
  buildTaskGraphProjectionFromWorkerRun,
  type TaskGraphProjectionNode,
} from '../projectControl/taskGraphProjection';
import type { ProjectIssue, ProjectIssueStatus, ProjectIssueType } from '../projectControl/types';
import type { DomainProjection } from '../domain/contracts';

interface IssueBoardProps {
  onBack: () => void;
  onOpenAdvanced: () => void;
}

type IssueColumnKey = 'inbox' | 'queued' | 'active' | 'delivered';

const COLUMNS: Array<{
  key: IssueColumnKey;
  statuses: ProjectIssueStatus[];
  icon: typeof Inbox;
}> = [
  { key: 'inbox', statuses: ['inbox', 'triaging', 'proposed'], icon: Inbox },
  { key: 'queued', statuses: ['approved', 'queued'], icon: ClipboardList },
  { key: 'active', statuses: ['in_progress', 'review', 'blocked', 'paused'], icon: Wrench },
  { key: 'delivered', statuses: ['done', 'operating'], icon: Sparkles },
];

const ISSUE_TYPES: ProjectIssueType[] = ['idea', 'feature', 'bug', 'risk', 'question'];

const EMPTY_DOMAIN_PROJECTION: DomainProjection = {
  lastSequence: 0,
  runs: {},
  tasks: {},
  taskExecutions: {},
  attempts: {},
};

function issueColumnForTaskStatus(status: ProjectIssueStatus): IssueColumnKey {
  return COLUMNS.find((column) => column.statuses.includes(status))?.key ?? 'inbox';
}

function issueId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `issue-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}

async function persistIssueTransition(issueIdValue: string, status: ProjectIssueStatus, now: string): Promise<void> {
  const state = useWorkflowStore.getState();
  const result = transitionIssueCommand({
    snapshot: state.projectControl,
    issueId: issueIdValue,
    status,
    now,
  });
  if (state.projectId) recordProjectEvents(state.projectId, result.events);
  state.setProjectControl(result.snapshot);
  if (state.projectPath) await state.saveProject();
}

export default function IssueBoard({ onBack, onOpenAdvanced }: IssueBoardProps) {
  const t = useT('beginner');
  const projectId = useWorkflowStore((state) => state.projectId);
  const projectName = useWorkflowStore((state) => state.projectName);
  const projectControl = useWorkflowStore((state) => state.projectControl);
  const workerRuns = useWorkflowStore((state) => state.workerRuns);
  const taskGraphSelection = useViewStore((state) => state.taskGraphSelection);
  const setTaskGraphSelection = useViewStore((state) => state.setTaskGraphSelection);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ProjectIssueType>('idea');
  const [unassigned, setUnassigned] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleIssues = useMemo(
    () => projectControl.issues.filter((issue) => issue.projectId === projectId || issue.projectId === null),
    [projectControl.issues, projectId],
  );

  const taskNodesByIssueId = useMemo(() => {
    const nodes = new Map<string, TaskGraphProjectionNode>();
    for (const graph of projectControl.taskGraphs ?? []) {
      const graphRuns = workerRuns
        .filter((run) => run.projectId === projectId && run.taskGraphId === graph.id)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      const latestRun = graphRuns.at(-1);
      const projection = latestRun
        ? buildTaskGraphProjectionFromWorkerRun({ graph, issues: visibleIssues, run: latestRun })
        : buildTaskGraphProjection({
          graph,
          issues: visibleIssues,
          execution: EMPTY_DOMAIN_PROJECTION,
        });
      for (const node of projection.nodes) {
        nodes.set(node.issueId, node);
      }
    }
    return nodes;
  }, [projectControl.taskGraphs, projectId, visibleIssues, workerRuns]);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    try {
      const now = new Date().toISOString();
      const issue = createIssue({
        id: issueId(),
        projectId: unassigned ? null : projectId,
        type,
        title,
        description: description.trim() || title,
        createdAt: now,
      });
      const state = useWorkflowStore.getState();
      state.setProjectControl({ ...state.projectControl, issues: [issue, ...state.projectControl.issues] });
      setTitle('');
      setDescription('');
      setType('idea');
      setUnassigned(false);
      setShowComposer(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleQueue = async (issueIdValue: string) => {
    try {
      await persistIssueTransition(issueIdValue, 'queued', new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApprove = async (issueIdValue: string) => {
    try {
      await persistIssueTransition(issueIdValue, 'approved', new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleTriage = async (issueIdValue: string) => {
    try {
      await persistIssueTransition(issueIdValue, 'triaging', new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="sm-beginner-shell">
      <main className="sm-beginner-main sm-beginner-issue-board">
        <div className="sm-beginner-issue-topline">
          <button type="button" className="sm-beginner-back-link" onClick={onBack}>
            <ArrowLeft size={14} /> {t('issue.back')}
          </button>
          <div className="sm-beginner-session-top-actions">
            <span className="sm-beginner-issue-project">{projectName || t('project.local')}</span>
            <button type="button" className="sm-beginner-text-button" onClick={onOpenAdvanced}>
              {t('issue.openAdvanced')} <ArrowRight size={14} />
            </button>
          </div>
        </div>

        <section className="sm-beginner-issue-heading" aria-labelledby="issue-board-title">
          <div className="sm-beginner-issue-heading-icon"><ClipboardList size={22} /></div>
          <div>
            <p className="sm-beginner-eyebrow">{t('issue.eyebrow')}</p>
            <h1 id="issue-board-title">{t('issue.title')}</h1>
            <p>{t('issue.subtitle')}</p>
          </div>
        </section>

        <div className="sm-beginner-issue-toolbar">
          <div>
            <strong>{t('issue.currentProject')}</strong>
            <span>{t('issue.visibleCount', { count: visibleIssues.length })}</span>
          </div>
          <button type="button" className="sm-beginner-primary-button" onClick={() => setShowComposer((value) => !value)}>
            <Plus size={16} /> {t('issue.newIssue')}
          </button>
        </div>

        {showComposer && (
          <form className="sm-beginner-issue-composer" onSubmit={handleCreate}>
            <div className="sm-beginner-issue-composer-fields">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('issue.titlePlaceholder')}
                aria-label={t('issue.titleLabel')}
              />
              <select value={type} onChange={(event) => setType(event.target.value as ProjectIssueType)} aria-label={t('issue.typeLabel')}>
                {ISSUE_TYPES.map((value) => <option key={value} value={value}>{t(`issue.type.${value}`)}</option>)}
              </select>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('issue.descriptionPlaceholder')}
                aria-label={t('issue.descriptionLabel')}
                rows={2}
              />
            </div>
            <label className="sm-beginner-issue-unassigned">
              <input type="checkbox" checked={unassigned} onChange={(event) => setUnassigned(event.target.checked)} />
              {t('issue.unassigned')}
            </label>
            <button type="submit" className="sm-beginner-primary-button" disabled={!title.trim()}>
              <Plus size={16} /> {t('issue.create')}
            </button>
          </form>
        )}

        {error && <p className="sm-beginner-inline-error" role="alert">{error}</p>}

        <div className="sm-beginner-issue-columns">
          {COLUMNS.map(({ key, statuses, icon: Icon }) => {
            const issues = visibleIssues.filter((issue) => statuses.includes(issue.status));
            return (
              <section key={key} data-issue-column={key} className="sm-beginner-issue-column">
                <div className="sm-beginner-issue-column-heading">
                  <div><Icon size={15} /><strong>{t(`issue.column.${key}`)}</strong></div>
                  <span>{issues.length}</span>
                </div>
                {issues.length === 0 ? (
                  <div className="sm-beginner-issue-empty"><CircleDashed size={18} /><span>{t('issue.empty')}</span></div>
                ) : (
                  <div className="sm-beginner-issue-list">
                    {issues.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        taskNode={taskNodesByIssueId.get(issue.id)}
                        selected={taskGraphSelection?.projectId === projectId && taskGraphSelection.issueId === issue.id}
                        onSelectTask={(node) => {
                          if (!projectId || !node.graphId) return;
                          setTaskGraphSelection({
                            projectId,
                            taskGraphId: node.graphId,
                            taskId: node.taskId,
                            issueId: node.issueId,
                          });
                        }}
                        t={t}
                        onQueue={handleQueue}
                        onApprove={handleApprove}
                        onTriage={handleTriage}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function IssueCard({
  issue,
  taskNode,
  selected,
  onSelectTask,
  t,
  onQueue,
  onApprove,
  onTriage,
}: {
  issue: ProjectIssue;
  taskNode?: TaskGraphProjectionNode;
  selected: boolean;
  onSelectTask: (node: TaskGraphProjectionNode) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  onQueue: (id: string) => void;
  onApprove: (id: string) => void;
  onTriage: (id: string) => void;
}) {
  return (
    <article
      className={`sm-beginner-issue-card is-${issue.status}${selected ? ' is-task-selected' : ''}`}
      data-task-selected={selected ? 'true' : 'false'}
      onClick={taskNode ? () => onSelectTask(taskNode) : undefined}
    >
      <div className="sm-beginner-issue-card-meta">
        <span>{t(`issue.type.${issue.type}`)}</span>
        <span className={`sm-beginner-issue-priority is-${issue.priority}`}>{t(`issue.priority.${issue.priority}`)}</span>
      </div>
      <h3>{issue.title}</h3>
      <p>{issue.description}</p>
      {issue.tags.length > 0 && (
        <div className="sm-beginner-issue-tags">{issue.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
      )}
      {taskNode && (
        <div
          className="sm-beginner-issue-task-link"
          data-testid={`issue-task-${issue.id}`}
          data-task-id={taskNode.taskId}
          data-task-status={taskNode.projectedStatus}
        >
          <span>{t('issue.taskLink')}</span>
          <code>{taskNode.taskId}</code>
          <span>{t(`issue.column.${issueColumnForTaskStatus(taskNode.projectedStatus)}`)}</span>
          <span>{t('issue.evidenceCount', { count: taskNode.evidenceIds.length })}</span>
        </div>
      )}
      <div className="sm-beginner-issue-card-footer">
        <span>{issue.projectId ? t('issue.assigned') : t('issue.unclaimed')}</span>
        {issue.status === 'approved' && issue.projectId && (
          <button type="button" data-testid={`issue-queue-${issue.id}`} className="sm-beginner-issue-action" onClick={() => onQueue(issue.id)}>
            <RotateCcw size={12} /> {t('issue.queue')}
          </button>
        )}
        {(issue.status === 'inbox' || issue.status === 'triaging') && issue.projectId && (
          <button type="button" data-testid={`issue-approve-${issue.id}`} className="sm-beginner-issue-action" onClick={() => onApprove(issue.id)}>
            <ClipboardList size={12} /> {t('issue.approve')}
          </button>
        )}
        {(issue.status === 'inbox' || issue.status === 'triaging') && !issue.projectId && (
          <button type="button" data-testid={`issue-triage-${issue.id}`} className="sm-beginner-issue-action" onClick={() => onTriage(issue.id)}>
            <Sparkles size={12} /> {t('issue.triage')}
          </button>
        )}
      </div>
    </article>
  );
}
