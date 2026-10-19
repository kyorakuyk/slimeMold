import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EventStoreAdapter } from '../domain/eventStore';
import type { DomainEvent } from '../domain/contracts';
import { getPendingProjectEvents } from '../projectControl/eventBuffer';
import type { GraphGrowthProjection } from '../projectControl/graphGrowthProjection';
import { graphGrowthProjection } from '../projectControl/graphGrowthProjection';
import {
  createGraphGrowthEventSource,
  type GraphGrowthEventSourceSnapshot,
} from '../projectControl/graphGrowthEventSource';
import { useT } from '../i18n/useT';
import LivingGraph from '../canvas/LivingGraph';
import TaskGrowthTimeline from './TaskGrowthTimeline';

export interface ProfessionalCanvasWorkspaceProps {
  projectRoot: string | null;
  projectId: string | null;
  isTauri: boolean;
  eventStoreAdapter?: Pick<EventStoreAdapter, 'readText'>;
  editor?: ReactNode;
  renderEditor?: (isActive: boolean) => ReactNode;
  onReplayModeChange: (replaying: boolean) => void;
}

const EMPTY_SNAPSHOT: GraphGrowthEventSourceSnapshot = {
  status: 'empty',
  events: [],
  corruptLineCount: 0,
};

const EMPTY_PROJECTION = graphGrowthProjection([], 0);

type CanvasTab = 'graph' | 'editor';

function createLazyTauriEventStoreAdapter(
  projectRoot: string,
): Pick<EventStoreAdapter, 'readText'> {
  let adapterPromise: Promise<Pick<EventStoreAdapter, 'readText'>> | null = null;
  return {
    readText: async (path) => {
      adapterPromise ??= import('../domain/tauriEventStore').then(({ createTauriEventStoreAdapter }) => (
        createTauriEventStoreAdapter(projectRoot)
      ));
      return (await adapterPromise).readText(path);
    },
  };
}

export default function ProfessionalCanvasWorkspace({
  projectRoot,
  projectId,
  isTauri,
  eventStoreAdapter,
  editor,
  renderEditor,
  onReplayModeChange,
}: ProfessionalCanvasWorkspaceProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<CanvasTab>('graph');
  const [snapshot, setSnapshot] = useState<GraphGrowthEventSourceSnapshot>(EMPTY_SNAPSHOT);
  const [pendingEvents, setPendingEvents] = useState<readonly DomainEvent[]>([]);
  const [pendingEventsError, setPendingEventsError] = useState(false);
  const [replaySequence, setReplaySequence] = useState<number | null>(null);

  const adapter = useMemo(() => {
    if (eventStoreAdapter) return eventStoreAdapter;
    if (!isTauri || !projectRoot) return undefined;
    return createLazyTauriEventStoreAdapter(projectRoot);
  }, [eventStoreAdapter, isTauri, projectRoot]);

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT);
    setReplaySequence(null);
    onReplayModeChange(false);
    const source = createGraphGrowthEventSource({ isTauri, projectRoot, adapter });
    const unsubscribe = source.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      onReplayModeChange(false);
    };
  }, [adapter, isTauri, onReplayModeChange, projectRoot]);

  useEffect(() => {
    if (!projectId || !projectId.trim()) {
      setPendingEvents([]);
      setPendingEventsError(false);
      return;
    }
    let active = true;
    const refreshPendingEvents = () => {
      try {
        const nextEvents = getPendingProjectEvents(projectId);
        if (active) {
          setPendingEvents((current) => (
            current.length === nextEvents.length
            && current.every((event, index) => (
              event.eventId === nextEvents[index]?.eventId
              && event.sequence === nextEvents[index]?.sequence
            ))
              ? current
              : nextEvents
          ));
          setPendingEventsError(false);
        }
      } catch {
        if (active) {
          setPendingEvents([]);
          setPendingEventsError(true);
        }
      }
    };
    refreshPendingEvents();
    const interval = globalThis.setInterval(refreshPendingEvents, 1_000);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
    };
  }, [projectId]);

  const events = snapshot.status === 'error'
    ? []
    : snapshot.events.length > 0 ? snapshot.events : pendingEvents;
  const lastSequence = events.at(-1)?.sequence ?? 0;
  const currentSequence = replaySequence === null
    ? lastSequence
    : Math.min(replaySequence, lastSequence);
  const replaying = replaySequence !== null && currentSequence < lastSequence;

  useEffect(() => {
    if (replaySequence !== null && replaySequence >= lastSequence) setReplaySequence(null);
  }, [lastSequence, replaySequence]);
  useEffect(() => {
    onReplayModeChange(replaying);
  }, [onReplayModeChange, replaying]);

  const projectionResult = useMemo(() => {
    try {
      return { projection: graphGrowthProjection(events, currentSequence), failed: false };
    } catch {
      return { projection: EMPTY_PROJECTION, failed: true };
    }
  }, [currentSequence, events]);
  // `graphGrowthProjection` rebuilds a prefix, so carry the source's live tail
  // separately for the timeline's replay/live boundary.
  const projection: GraphGrowthProjection = useMemo(() => ({
    ...projectionResult.projection,
    uptoSeq: currentSequence,
    lastSequence,
  }), [currentSequence, lastSequence, projectionResult.projection]);

  const handleSeek = useCallback((sequence: number) => {
    if (!Number.isSafeInteger(sequence)) return;
    const boundedSequence = Math.min(Math.max(sequence, 0), lastSequence);
    const nextReplaySequence = boundedSequence < lastSequence ? boundedSequence : null;
    setReplaySequence(nextReplaySequence);
    onReplayModeChange(nextReplaySequence !== null);
  }, [lastSequence, onReplayModeChange]);

  const returnToLive = useCallback(() => {
    setReplaySequence(null);
    onReplayModeChange(false);
  }, [onReplayModeChange]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="professional-canvas-workspace">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-sm-line px-3" role="tablist" aria-label={t('canvas.livingGraph.tabs')}>
        <button
          id="professional-canvas-graph-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === 'graph'}
          aria-controls="professional-canvas-graph-panel"
          data-testid="workspace-graph-tab"
          className="rounded px-2.5 py-1 text-xs text-sm-ink-soft aria-selected:bg-sm-bg aria-selected:font-medium aria-selected:text-sm-ink"
          onClick={() => setActiveTab('graph')}
        >
          {t('canvas.livingGraph.tab.graph')}
        </button>
        <button
          id="professional-canvas-editor-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === 'editor'}
          aria-controls="professional-canvas-editor-panel"
          data-testid="workspace-editor-tab"
          className="rounded px-2.5 py-1 text-xs text-sm-ink-soft aria-selected:bg-sm-bg aria-selected:font-medium aria-selected:text-sm-ink"
          onClick={() => setActiveTab('editor')}
        >
          {t('canvas.livingGraph.tab.editor')}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <section
          id="professional-canvas-graph-panel"
          role="tabpanel"
          aria-labelledby="professional-canvas-graph-tab"
          hidden={activeTab !== 'graph'}
          className="absolute inset-0 min-h-0"
          data-testid="workspace-graph-panel"
        >
          {(snapshot.status === 'error' || pendingEventsError) && (
            <p role="alert" data-testid="workspace-event-error" className="px-3 py-2 text-xs text-err">
              {t('canvas.livingGraph.eventSourceError')}
            </p>
          )}
          {projectionResult.failed && (
            <p role="alert" data-testid="workspace-projection-error" className="px-3 py-2 text-xs text-err">
              {t('canvas.livingGraph.projectionError')}
            </p>
          )}
          {snapshot.corruptLineCount > 0 && (
            <p role="status" data-testid="workspace-corrupt-events" className="px-3 py-2 text-xs text-sm-ink-faint">
              {t('canvas.livingGraph.corruptEvents', { count: snapshot.corruptLineCount })}
            </p>
          )}
          <div className="h-full min-h-0">
            <LivingGraph projection={projection} />
          </div>
        </section>
        <section
          id="professional-canvas-editor-panel"
          role="tabpanel"
          aria-labelledby="professional-canvas-editor-tab"
          hidden={activeTab !== 'editor'}
          className="absolute inset-0 min-h-0"
          data-testid="workspace-editor-panel"
        >
          {renderEditor ? renderEditor(activeTab === 'editor') : editor}
        </section>
      </div>

      <TaskGrowthTimeline
        events={events}
        projection={projection}
        onSeek={handleSeek}
        onReturnToLive={returnToLive}
      />
    </div>
  );
}
