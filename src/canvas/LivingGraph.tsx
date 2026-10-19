import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useT } from '../i18n/useT';
import type { GraphGrowthCapsule, GraphGrowthNode, GraphGrowthProjection } from '../projectControl/graphGrowthProjection';
import { layoutGraphGrowth, type GraphGrowthPosition } from '../projectControl/graphGrowthLayout';
import { LivingGraphNodeView, type LivingGraphFlowNode } from './LivingGraphNode';

interface LivingGraphProps {
  projection: GraphGrowthProjection;
}

type ZoomMode = 'far' | 'near';

const SEMANTIC_ZOOM_THRESHOLD = 0.72;
const nodeTypes = { livingGraphNode: LivingGraphNodeView };

function capsuleKey(graphId?: string, moduleId?: string): string | undefined {
  return graphId && moduleId ? `${graphId}\u0000${moduleId}` : undefined;
}

function capsuleForNode(
  node: GraphGrowthNode,
  capsules: ReadonlyMap<string, GraphGrowthCapsule>,
): GraphGrowthCapsule | undefined {
  if (node.kind !== 'module') return undefined;
  const key = capsuleKey(node.graphId, node.moduleId);
  return key ? capsules.get(key) : undefined;
}

export default function LivingGraph({ projection }: LivingGraphProps) {
  const t = useT('ui');
  if (projection.nodes.length === 0 || projection.lastSequence === 0) {
    return (
      <div
        data-testid="living-graph-empty"
        className="flex h-full min-h-[320px] w-full items-center justify-center rounded-lg bg-sm-canvas px-6 text-center text-sm text-sm-ink-faint"
        aria-live="polite"
      >
        {t('canvas.livingGraph.empty')}
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <LivingGraphCanvas projection={projection} />
    </ReactFlowProvider>
  );
}

function LivingGraphCanvas({ projection }: LivingGraphProps) {
  const t = useT('ui');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('near');
  const [expandedCapsules, setExpandedCapsules] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const cachedPositions = useRef<ReadonlyMap<string, GraphGrowthPosition>>(new Map());

  const positions = useMemo(() => {
    const next = layoutGraphGrowth(projection.nodes, cachedPositions.current);
    cachedPositions.current = new Map(next);
    return next;
  }, [projection.nodes]);

  const capsulesByModule = useMemo(() => new Map(
    projection.capsules.map((capsule) => [capsuleKey(capsule.graphId, capsule.moduleId)!, capsule]),
  ), [projection.capsules]);

  const visibleNodes = useMemo(() => projection.nodes.filter((node) => {
    if (zoomMode === 'far' && node.kind !== 'session' && node.kind !== 'module') return false;
    if (node.kind !== 'task' && node.kind !== 'attempt') return true;
    const key = capsuleKey(node.graphId, node.moduleId);
    return !key || !capsulesByModule.has(key) || expandedCapsules.has(key);
  }), [projection.nodes, zoomMode, capsulesByModule, expandedCapsules]);

  const ringByAttempt = useMemo(() => {
    const rings = new Map<string, GraphGrowthProjection['rings'][number]>();
    for (const ring of projection.rings) {
      // Unknown remains a dashed attempt outline until the product semantics are decided.
      if (ring.outcome !== 'unknown') rings.set(ring.attemptId, ring);
    }
    return rings;
  }, [projection.rings]);

  const toggleCapsule = useCallback((key: string) => {
    setExpandedCapsules((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const flowNodes = useMemo<LivingGraphFlowNode[]>(() => visibleNodes.map((source) => {
    const capsule = capsuleForNode(source, capsulesByModule);
    const key = capsule ? capsuleKey(capsule.graphId, capsule.moduleId) : undefined;
    const position = positions.get(source.id);
    if (!position) throw new Error(`living graph node has no stable layout position: ${source.id}`);
    return {
      id: source.id,
      type: 'livingGraphNode',
      position,
      data: {
        source,
        capsule,
        capsuleExpanded: !!key && expandedCapsules.has(key),
        ring: source.attemptId ? ringByAttempt.get(source.attemptId) : undefined,
        onToggleCapsule: key ? () => toggleCapsule(key) : undefined,
      },
      draggable: false,
      connectable: false,
      selectable: false,
      deletable: false,
    };
  }), [visibleNodes, capsulesByModule, positions, expandedCapsules, ringByAttempt, toggleCapsule]);

  const visibleNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const flowEdges = useMemo<Edge[]>(() => projection.edges
    .filter((edge) => visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId))
    .map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      type: 'smoothstep',
      selectable: false,
      focusable: false,
      style: {
        stroke: edge.flowCount > 0 ? 'var(--sm-accent)' : 'var(--sm-edge)',
        strokeWidth: edge.flowCount > 0 ? Math.min(6, 1.5 + Math.log2(edge.flowCount + 1)) : 1.25,
        ...(edge.kind === 'dependency' ? { strokeDasharray: '4 4' } : {}),
      },
    })), [projection.edges, visibleNodeIds]);

  const selectedNode = projection.nodes.find((node) => node.id === selectedNodeId);
  const eventIds = selectedNode ? [...new Set(selectedNode.eventIds)] : [];
  const handleMoveEnd = useCallback((
    _event: MouseEvent | TouchEvent | null,
    viewport: { x: number; y: number; zoom: number },
  ) => {
    const nextMode: ZoomMode = viewport.zoom < SEMANTIC_ZOOM_THRESHOLD ? 'far' : 'near';
    setZoomMode((current) => current === nextMode ? current : nextMode);
  }, []);

  return (
    <div
      data-testid="living-graph-root"
      className="relative h-full min-h-[320px] w-full overflow-hidden rounded-lg bg-sm-canvas"
      aria-label={t('canvas.livingGraph.details.title')}
    >
      <ReactFlow<LivingGraphFlowNode, Edge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        deleteKeyCode={null}
        connectOnClick={false}
        edgesReconnectable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.55}
        maxZoom={1.8}
        onMoveEnd={handleMoveEnd}
        onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--sm-canvas-grid)" />
      </ReactFlow>
      {selectedNode && (
        <aside
          data-testid="living-graph-event-details"
          className="absolute bottom-3 left-3 z-10 max-h-[40%] w-[min(360px,calc(100%-24px))] overflow-auto rounded-lg border border-sm-line bg-sm-panel p-3 text-xs text-sm-ink shadow-md"
          aria-label={t('canvas.livingGraph.details.title')}
        >
          <h2 className="font-medium">{selectedNode.label}</h2>
          <div className="mt-2 text-sm-ink-faint">{t('canvas.livingGraph.details.eventIds')}</div>
          {eventIds.length > 0 ? (
            <ul className="mt-1 space-y-1 font-mono">
              {eventIds.map((eventId) => <li key={eventId} className="break-all">{eventId}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-sm-ink-faint">{t('canvas.livingGraph.details.noEvents')}</p>
          )}
        </aside>
      )}
    </div>
  );
}
