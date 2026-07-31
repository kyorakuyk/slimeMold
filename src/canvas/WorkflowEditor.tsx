import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
  type NodeTypes,
  type Connection,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import BaseNode from './nodes/BaseNode';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { getNodeDef } from '../store/registryStore';
import { arePortsCompatible } from '../types';
import { wouldCreateCycle } from '../engine/topoSort';

const nodeTypes: NodeTypes = { base: BaseNode };

// 小地图节点配色（与 CSS 分类变量同语义，深色调更亮以保证可见）
const CAT_COLORS: Record<string, string> = {
  输入: '#51cf66',
  AI: '#9775fa',
  智能体: '#9775fa',
  文本: '#4dabf7',
  工具: '#ffa94d',
  输出: '#f783ac',
  流程: '#3bc9db',
};

export const DND_MIME = 'application/x-slime-node';

export default function WorkflowEditor() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const onConnect = useWorkflowStore((s) => s.onConnect);
  const addNode = useWorkflowStore((s) => s.addNode);
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const setSelected = useWorkflowStore((s) => s.setSelected);
  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const { screenToFlowPosition } = useReactFlow();

  // 连线时的友好预校验：环路或端口类型不兼容时，手柄直接显示不可连接
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target) return false;
      if (conn.source === conn.target) return false;
      if (wouldCreateCycle(conn.source, conn.target, edges)) return false;
      const srcDef = getNodeDef(conn.source);
      const tgtDef = getNodeDef(conn.target);
      const srcPort = srcDef?.outputs.find((o) => o.id === conn.sourceHandle);
      const tgtPort = tgtDef?.inputs.find((i) => i.id === conn.targetHandle);
      return arePortsCompatible(srcPort?.type, tgtPort?.type);
    },
    [edges],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const typeId = e.dataTransfer.getData(DND_MIME);
      if (!typeId) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(typeId, { x: position.x - 112, y: position.y - 20 });
    },
    [addNode, screenToFlowPosition],
  );

  const applyTemplate = useCallback(
    (id: string) => {
      const tpl = STARTER_TEMPLATES.find((t) => t.id === id);
      if (!tpl) return;
      const { nodes: n, edges: e } = tpl.build();
      loadGraph('新手模板 · ' + tpl.name, n, e, [], []);
    },
    [loadGraph],
  );

  const defaultEdgeOptions = useMemo(
    () => ({
      type: 'smoothstep' as const,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--sm-edge)' },
    }),
    [],
  );

  const isEmpty = nodes.length === 0;

  return (
    <div className="sm-canvas-dot relative h-full w-full" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => setSelected(node.id)}
        onPaneClick={() => setSelected(null)}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2.5}
      >
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="var(--sm-canvas-grid)"
          />
        )}
        <Controls position="bottom-left" showInteractive={false} />
        {showMinimap && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => CAT_COLORS[(n.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
            nodeStrokeColor={(n) => CAT_COLORS[(n.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
            maskColor="rgba(0,0,0,0.45)"
          />
        )}
      </ReactFlow>

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="pointer-events-auto w-[460px] max-w-[90%] rounded-2xl border p-6 shadow-xl"
            style={{ background: 'var(--sm-bg-panel)', borderColor: 'var(--sm-line)' }}>
            <h2 className="text-[17px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
              欢迎使用 slimeMold 👋
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
              把节点拖到画布上，连成一条工作流就能运行。或者从下面挑一个模板，一键开始：
            </p>
            <div className="mt-4 space-y-2">
              {STARTER_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t.id)}
                  className="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition hover:border-[var(--sm-accent)]"
                  style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
                >
                  <span className="text-[22px] leading-none">{t.emoji}</span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                      {t.name}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                      {t.desc}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-4 text-[11.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
              提示：左侧「节点库」可搜索所有节点；AI 节点默认开启离线模拟，无需配置即可试跑。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
