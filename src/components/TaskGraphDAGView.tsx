import type { TaskGraphProjection, TaskGraphProjectionNode } from '../projectControl/taskGraphProjection';
import { useT } from '../i18n/useT';

function taskStatusKey(node: TaskGraphProjectionNode): string {
  if (node.executionStatus === 'running') return 'running';
  if (node.executionStatus === 'succeeded') return 'succeeded';
  if (node.executionStatus === 'failed') return 'failed';
  if (node.executionStatus === 'blocked') return 'blocked';
  if (node.executionStatus === 'cancelled') return 'cancelled';
  if (node.executionStatus === 'queued') return 'queued';
  if (node.projectedStatus === 'done') return 'succeeded';
  if (node.projectedStatus === 'blocked') return 'blocked';
  if (node.projectedStatus === 'cancelled') return 'cancelled';
  return 'queued';
}

export default function TaskGraphDAGView({ projection }: { projection: TaskGraphProjection }) {
  const t = useT('panels');

  return (
    <section className="sm-taskgraph-dag" data-testid="taskgraph-dag-view">
      <div className="sm-taskgraph-dag-heading">
        <div>
          <p className="sm-taskgraph-dag-eyebrow">{t('orchestrator.taskGraph.title')}</p>
          <h3>{projection.graphId}</h3>
        </div>
        <div className="sm-taskgraph-dag-meta">
          <span>{t('orchestrator.taskGraph.version', { version: projection.graphVersion })}</span>
          {projection.runId && <span>{t('orchestrator.taskGraph.run', { runId: projection.runId })}</span>}
        </div>
      </div>

      <div className="sm-taskgraph-dag-nodes" role="list" aria-label={t('orchestrator.taskGraph.title')}>
        {projection.nodes.map((node) => (
          <article
            key={node.taskId}
            className={`sm-taskgraph-dag-node is-${node.projectedStatus}`}
            data-testid={`taskgraph-node-${node.taskId}`}
            data-task-status={node.projectedStatus}
            data-task-consistency={node.consistency}
          >
            <div className="sm-taskgraph-dag-node-title">
              <strong>{node.title}</strong>
              <span>{t(`orchestrator.worker.task.${taskStatusKey(node)}`)}</span>
            </div>
            <code>{node.taskId}</code>
            <div className="sm-taskgraph-dag-node-lineage">
              <span>{t('orchestrator.taskGraph.issue')}: {node.issueId}</span>
              {node.evidenceIds.length > 0 && (
                <span>{t('orchestrator.taskGraph.evidence')}: {node.evidenceIds.length}</span>
              )}
              {node.acceptanceId && (
                <span>{t('orchestrator.taskGraph.acceptance')}: {node.acceptanceId}</span>
              )}
            </div>
          </article>
        ))}
      </div>

      {projection.edges.length > 0 && (
        <ul className="sm-taskgraph-dag-edges" aria-label={t('orchestrator.taskGraph.edge')}>
          {projection.edges.map((edge) => (
            <li key={`${edge.fromTaskId}-${edge.toTaskId}`} data-testid={`taskgraph-edge-${edge.fromTaskId}-${edge.toTaskId}`}>
              <code>{edge.fromTaskId}</code> → <code>{edge.toTaskId}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
