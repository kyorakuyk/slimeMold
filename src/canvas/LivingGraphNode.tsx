import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type {
  GraphGrowthCapsule,
  GraphGrowthNode,
  GraphGrowthRing,
  GraphGrowthStatus,
} from '../projectControl/graphGrowthProjection';
import { useT } from '../i18n/useT';

export interface LivingGraphNodeData extends Record<string, unknown> {
  source: GraphGrowthNode;
  capsule?: GraphGrowthCapsule;
  capsuleExpanded: boolean;
  ring?: GraphGrowthRing;
  onToggleCapsule?: () => void;
}

export type LivingGraphFlowNode = Node<LivingGraphNodeData, 'livingGraphNode'>;

function statusColor(status: GraphGrowthStatus): string {
  switch (status) {
    case 'running': return 'var(--sm-accent)';
    case 'waiting-feedback':
    case 'blocked': return 'var(--sm-run)';
    case 'succeeded': return 'var(--sm-ok)';
    case 'failed': return 'var(--sm-err)';
    case 'idle':
    case 'queued':
    case 'unverified':
    case 'unknown':
    case 'cancelled': return 'var(--sm-ink-faint)';
  }
}

function statusLabel(t: ReturnType<typeof useT>, status: GraphGrowthStatus): string {
  switch (status) {
    case 'idle': return t('canvas.livingGraph.status.idle');
    case 'queued': return t('canvas.livingGraph.status.queued');
    case 'running': return t('canvas.livingGraph.status.running');
    case 'waiting-feedback': return t('canvas.livingGraph.status.waitingFeedback');
    case 'blocked': return t('canvas.livingGraph.status.blocked');
    case 'succeeded': return t('canvas.livingGraph.status.succeeded');
    case 'unverified': return t('canvas.livingGraph.status.unverified');
    case 'failed': return t('canvas.livingGraph.status.failed');
    case 'unknown': return t('canvas.livingGraph.status.unknown');
    case 'cancelled': return t('canvas.livingGraph.status.cancelled');
  }
}

function ringColor(outcome: GraphGrowthRing['outcome']): string {
  switch (outcome) {
    case 'succeeded': return 'var(--sm-ok)';
    case 'failed': return 'var(--sm-err)';
    case 'cancelled': return 'var(--sm-ink-faint)';
    case 'unknown': return 'transparent';
  }
}

export const LivingGraphNodeView = memo(function LivingGraphNodeView({
  id,
  data,
}: NodeProps<LivingGraphFlowNode>) {
  const t = useT('ui');
  const { source, capsule, capsuleExpanded, ring, onToggleCapsule } = data;
  const color = statusColor(source.status);
  const pulse = source.status === 'running' && source.leaseHeld && source.pulse;
  const label = source.kind === 'attempt'
    ? t('canvas.livingGraph.attempt', { attempt: source.attempt ?? 1 })
    : source.label;
  const evidenceCount = capsule?.evidenceRefs.length ?? source.evidenceIds.length;
  const toggleLabel = capsuleExpanded
    ? t('canvas.livingGraph.capsule.collapse')
    : t('canvas.livingGraph.capsule.expand');

  return (
    <div
      id={id}
      data-testid={`living-graph-node-${source.id}`}
      data-graph-node-id={source.id}
      data-growth-status={source.status}
      data-growth-kind={source.kind}
      data-lease-held={source.leaseHeld}
      data-scar={source.scar}
      className={`relative box-border h-[100px] w-[240px] overflow-visible rounded-xl border bg-sm-bg px-3 py-2 text-sm-ink shadow-sm transition-colors ${source.scar ? 'opacity-70' : ''}`}
      style={{
        borderColor: color,
        borderStyle: source.status === 'unknown' ? 'dashed' : 'solid',
      }}
      title={source.eventIds.join('\n')}
      aria-label={`${source.label}: ${statusLabel(t, source.status)}`}
    >
      {ring && ring.outcome !== 'unknown' && (
        <span
          data-testid={`living-graph-ring-${ring.attemptId}`}
          data-outcome={ring.outcome}
          title={ring.eventId}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-1 rounded-[14px] border-2"
          style={{ borderColor: ringColor(ring.outcome) }}
        />
      )}
      <Handle type="target" position={Position.Top} aria-hidden="true" className="!h-1 !w-1 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} aria-hidden="true" className="!h-1 !w-1 !border-0 !bg-transparent" />
      <div className="relative z-10 flex h-full min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            data-testid={pulse ? `living-graph-pulse-${source.id}` : undefined}
            className={`h-2 w-2 shrink-0 rounded-full ${pulse ? 'motion-safe:animate-pulse motion-reduce:animate-none' : ''}`}
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[10px] text-sm-ink-soft">
            {statusLabel(t, source.status)}
          </span>
          {capsule && (
            <button
              type="button"
              data-testid={`living-graph-capsule-toggle-${source.id}`}
              className="nodrag nopan max-w-[112px] shrink-0 whitespace-nowrap rounded border border-sm-line px-1.5 py-0.5 text-[10px] text-sm-ink-soft hover:bg-sm-bg-soft"
              aria-label={toggleLabel}
              aria-expanded={capsuleExpanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggleCapsule?.();
              }}
            >
              {toggleLabel}
            </button>
          )}
        </div>
        <div className="mt-1 truncate text-xs font-medium" title={label}>{label}</div>
        <div className="mt-auto flex min-w-0 items-center gap-1 overflow-hidden text-[10px] text-sm-ink-faint">
          {capsule && (
            <>
              <span className="truncate" title={t('canvas.livingGraph.capsule.label')}>
                {t('canvas.livingGraph.capsule.label')}
              </span>
              <span className="truncate">{t('canvas.livingGraph.capsule.tasks', { count: capsule.taskIds.length })}</span>
            </>
          )}
          {evidenceCount > 0 && (
            <span className="shrink-0 rounded bg-sm-bg-soft px-1.5 py-0.5">
              {t('canvas.livingGraph.evidenceCount', { count: evidenceCount })}
            </span>
          )}
          {capsule && capsule.acceptanceRefs.length > 0 && (
            <span className="shrink-0 rounded bg-sm-bg-soft px-1.5 py-0.5">
              {t('canvas.livingGraph.capsule.acceptances', { count: capsule.acceptanceRefs.length })}
            </span>
          )}
          {!capsule && source.acceptanceId && (
            <span className="shrink-0 rounded bg-sm-bg-soft px-1.5 py-0.5">
              {t('canvas.livingGraph.acceptancePresent')}
            </span>
          )}
          {source.scar && (
            <span
              data-testid={`living-graph-scar-${source.attemptId ?? source.id}`}
              className="shrink-0 rounded border border-sm-line px-1.5 py-0.5"
            >
              {t('canvas.livingGraph.scar')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
