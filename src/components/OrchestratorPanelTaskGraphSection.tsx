import { useT } from '../i18n/useT';
import type { TaskGraphProjection, TaskGraphProjectionNode } from '../projectControl/taskGraphProjection';
import type { TaskGraphSelection } from '../store/viewStore';
import TaskGraphDAGView from './TaskGraphDAGView';

interface OrchestratorPanelTaskGraphSectionProps {
  projection: TaskGraphProjection | null;
  error: string | null;
  selection: TaskGraphSelection | null;
  selectedTaskId?: string;
  revisionTitle: string;
  revisionDependsOn: string;
  revisionBusy: boolean;
  onSelectTask: (node: TaskGraphProjectionNode) => void;
  onRevisionTitleChange: (value: string) => void;
  onRevisionDependsOnChange: (value: string) => void;
  onReviseTaskGraph: () => void | Promise<void>;
}

export default function OrchestratorPanelTaskGraphSection({
  projection,
  error,
  selection,
  selectedTaskId,
  revisionTitle,
  revisionDependsOn,
  revisionBusy,
  onSelectTask,
  onRevisionTitleChange,
  onRevisionDependsOnChange,
  onReviseTaskGraph,
}: OrchestratorPanelTaskGraphSectionProps) {
  const t = useT('panels');

  return (
    <>
      {projection && (
        <TaskGraphDAGView
          projection={projection}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      )}
      {projection && projection.approval !== 'superseded' && (
        <details className="rounded border border-line px-2.5 py-2" data-testid="taskgraph-revision-editor">
          <summary className="cursor-pointer text-[11px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
            {t('orchestrator.taskGraph.revise')}
          </summary>
          <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
            <p style={{ color: 'var(--sm-ink-faint)' }}>
              {t('orchestrator.taskGraph.selectedTask')}: {selection?.taskId ?? t('orchestrator.taskGraph.noneSelected')}
            </p>
            <input
              className="rounded border border-line bg-transparent px-2 py-1 outline-none focus:border-accent"
              placeholder={t('orchestrator.taskGraph.titlePlaceholder')}
              value={revisionTitle}
              onChange={(event) => onRevisionTitleChange(event.target.value)}
              disabled={!selection || revisionBusy}
            />
            <input
              className="rounded border border-line bg-transparent px-2 py-1 outline-none focus:border-accent"
              placeholder={t('orchestrator.taskGraph.dependsOnPlaceholder')}
              value={revisionDependsOn}
              onChange={(event) => onRevisionDependsOnChange(event.target.value)}
              disabled={!selection || revisionBusy}
            />
            <button
              type="button"
              className="sm-btn justify-center hover:border-accent hover:text-accent"
              onClick={() => { void onReviseTaskGraph(); }}
              disabled={!selection || revisionBusy}
            >
              {t('orchestrator.taskGraph.applyRevision')}
            </button>
          </div>
        </details>
      )}
      {error && (
        <div className="rounded border border-dashed border-warn px-2.5 py-1.5 text-[10.5px] text-warn" data-testid="orchestrator-taskgraph-dag-error">
          {error}
        </div>
      )}
    </>
  );
}
