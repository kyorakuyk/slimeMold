import type { CSSProperties } from 'react';
import type { DomainEvent } from '../domain/contracts';
import type { GraphGrowthMarker, GraphGrowthProjection } from '../projectControl/graphGrowthProjection';
import { useT } from '../i18n/useT';

export interface TaskGrowthTimelineProps {
  events: readonly DomainEvent[];
  projection: GraphGrowthProjection;
  onSeek: (sequence: number) => void;
  onReturnToLive: () => void;
}

interface DensityBucket {
  index: number;
  count: number;
  sequenceStart: number;
  sequenceEnd: number;
}

const MAX_DENSITY_BARS = 80;
const VISIBLE_MARKER_KINDS = new Set<GraphGrowthMarker['kind']>([
  'decision',
  'failure',
  'user-intervention',
]);

function densityBuckets(events: readonly DomainEvent[], lastSequence: number): DensityBucket[] {
  if (lastSequence <= 0) return [];
  const bucketCount = Math.min(MAX_DENSITY_BARS, lastSequence);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    count: 0,
    sequenceStart: Math.floor((index * lastSequence) / bucketCount) + 1,
    sequenceEnd: Math.floor(((index + 1) * lastSequence) / bucketCount),
  }));
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > lastSequence) continue;
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor(((event.sequence - 1) / lastSequence) * bucketCount),
    );
    buckets[bucketIndex].count += 1;
  }
  return buckets;
}

function markerPosition(sequence: number, lastSequence: number): CSSProperties {
  const boundedSequence = Math.min(Math.max(sequence, 1), lastSequence);
  return { left: `${((boundedSequence - 1) / Math.max(lastSequence - 1, 1)) * 100}%` };
}

function markerLabel(kind: GraphGrowthMarker['kind'], t: (key: string) => string): string {
  switch (kind) {
    case 'decision': return t('timeline.marker.decision');
    case 'failure': return t('timeline.marker.failure');
    case 'user-intervention': return t('timeline.marker.userIntervention');
    default: return '';
  }
}

export default function TaskGrowthTimeline({
  events,
  projection,
  onSeek,
  onReturnToLive,
}: TaskGrowthTimelineProps) {
  const t = useT();
  const lastSequence = projection.lastSequence;
  const currentSequence = Math.min(Math.max(projection.uptoSeq, 0), lastSequence);
  const replaying = currentSequence < lastSequence;
  const buckets = densityBuckets(events, lastSequence);
  const maxDensity = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const markers = projection.markers
    .filter((marker) => (
      VISIBLE_MARKER_KINDS.has(marker.kind)
      && marker.sequence >= 1
      && marker.sequence <= lastSequence
    ))
    .sort((left, right) => left.sequence - right.sequence);

  return (
    <section className="sm-growth-timeline border-t border-sm-line px-4 py-3" aria-label={t('timeline.title')}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-sm-ink-soft">{t('timeline.title')}</h2>
        {replaying && (
          <div
            className="flex items-center gap-2 rounded-full border border-sm-line px-2.5 py-1 text-xs text-sm-ink-soft"
            role="status"
            data-testid="timeline-replay-state"
          >
            <span>{t('timeline.replay.title')}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="font-medium text-sm-ink underline-offset-2 hover:underline"
              data-testid="timeline-return-live"
              onClick={onReturnToLive}
            >
              {t('timeline.returnToLive')}
            </button>
          </div>
        )}
      </header>

      {lastSequence > 0 && events.length > 0 ? (
        <>
          <div className="relative h-12" data-testid="timeline-density" aria-label={t('timeline.eventDensity')}>
            <div className="absolute inset-x-0 bottom-0 flex h-10 items-end gap-px" aria-hidden="true">
              {buckets.map((bucket) => (
                <span
                  key={bucket.index}
                  className="min-w-0 flex-1 rounded-t-sm bg-sm-ink/25"
                  data-testid="timeline-event-bar"
                  data-event-count={bucket.count}
                  data-sequence-start={bucket.sequenceStart}
                  data-sequence-end={bucket.sequenceEnd}
                  style={{ height: `${Math.max(6, (bucket.count / maxDensity) * 100)}%` }}
                />
              ))}
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-10" aria-hidden="true">
              {markers.map((marker) => (
                <span
                  key={marker.id}
                  className={`absolute top-0 h-2 w-2 -translate-x-1/2 rounded-full ring-2 ring-sm-bg ${
                    marker.kind === 'decision'
                      ? 'bg-sm-accent'
                      : marker.kind === 'failure'
                        ? 'bg-err'
                        : 'bg-warn'
                  }`}
                  data-testid="timeline-marker"
                  data-kind={marker.kind}
                  data-sequence={marker.sequence}
                  data-event-id={marker.eventId}
                  title={`${markerLabel(marker.kind, t)} · ${marker.eventId}`}
                  style={markerPosition(marker.sequence, lastSequence)}
                />
              ))}
            </div>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[10px] text-sm-ink-faint" aria-label={t('timeline.markerLegend')}>
            {(['decision', 'failure', 'user-intervention'] as const).map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    kind === 'decision' ? 'bg-sm-accent' : kind === 'failure' ? 'bg-err' : 'bg-warn'
                  }`}
                  aria-hidden="true"
                />
                {markerLabel(kind, t)}
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <label className="sr-only" htmlFor="task-growth-sequence">
              {t('timeline.scrubber')}
            </label>
            <input
              id="task-growth-sequence"
              className="h-2 min-w-0 flex-1 cursor-pointer accent-sm-accent"
              type="range"
              min={0}
              max={lastSequence}
              step={1}
              value={currentSequence}
              aria-valuetext={`${t('timeline.sequence')} ${currentSequence} / ${lastSequence}`}
              onChange={(event) => onSeek(Number(event.currentTarget.value))}
            />
            <output className="min-w-20 text-right font-mono text-[10px] text-sm-ink-faint">
              {t('timeline.sequence')} {currentSequence} / {lastSequence}
            </output>
          </div>
        </>
      ) : (
        <p className="py-3 text-xs text-sm-ink-faint" data-testid="timeline-empty">
          {t('timeline.empty')}
        </p>
      )}
    </section>
  );
}
