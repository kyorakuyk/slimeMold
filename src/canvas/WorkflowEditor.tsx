import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  MiniMap,
  ConnectionLineType,
  SelectionMode,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeTypes,
  type Connection,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LayoutTemplate, FilePlus2, FolderOpen, Sparkles, X, Hand, BoxSelect, Map, Minus, Plus, Maximize2 } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import BaseNode from './nodes/BaseNode';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { getNodeDef } from '../store/registryStore';
import { arePortsCompatible, type NodeDefinition, type FlowNode, type FlowEdge, type NodeStatus } from '../types';
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

export default function WorkflowEditor({ wfId }: { wfId?: string }) {
  // 无 wfId：渲染当前激活工作流（全局状态）；有 wfId：渲染并编辑指定工作流（拆分视图分栏）
  const isSplit = !!wfId;
  const activeNodes = useWorkflowStore((s) => s.nodes);
  const activeEdges = useWorkflowStore((s) => s.edges);
  const splitWf = useWorkflowStore((s) => (wfId ? s.workflows[wfId] : undefined));
  const updateWorkflowGraph = useWorkflowStore((s) => s.updateWorkflowGraph);
  const storeOnNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const storeOnEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const storeOnConnect = useWorkflowStore((s) => s.onConnect);
  const addNode = useWorkflowStore((s) => s.addNode);
  const setSelected = useWorkflowStore((s) => s.setSelected);

  // 分栏工作流：以本地状态维护其图，编辑时写回 workflows 字典
  const [splitNodes, setSplitNodes] = useState<FlowNode[]>([]);
  const [splitEdges, setSplitEdges] = useState<FlowEdge[]>([]);
  useEffect(() => {
    if (!isSplit || !splitWf) return;
    setSplitNodes(
      (splitWf.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'base',
        position: n.position,
        data: { typeId: n.typeId, label: n.label, params: n.params ?? {}, status: 'idle' as NodeStatus, dirty: true },
      })),
    );
    setSplitEdges(
      (splitWf.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
      })),
    );
  }, [isSplit, splitWf]);

  const nodes = isSplit ? splitNodes : activeNodes;
  const edges = isSplit ? splitEdges : activeEdges;

  const onNodesChange: OnNodesChange<FlowNode> = isSplit
    ? (changes) => setSplitNodes((ns) => applyNodeChanges(changes, ns))
    : storeOnNodesChange;
  const onEdgesChange: OnEdgesChange<FlowEdge> = isSplit
    ? (changes) => setSplitEdges((es) => applyEdgeChanges(changes, es))
    : storeOnEdgesChange;
  const onConnect: (conn: Connection) => void = isSplit
    ? (conn) => setSplitEdges((es) => addEdge({ ...conn, id: `e-${conn.source}-${conn.target}-${Date.now()}` }, es))
    : storeOnConnect;

  // 分栏编辑时，把最新图写回 store
  useEffect(() => {
    if (!isSplit || !wfId) return;
    updateWorkflowGraph(wfId, splitNodes, splitEdges);
  }, [isSplit, wfId, splitNodes, splitEdges, updateWorkflowGraph]);

  const handleNodeClick = useCallback(
    (_: unknown, node: FlowNode) => setSelected(node.id, wfId),
    [setSelected, wfId],
  );

  // 数据流向可视化：连线颜色跟随「源端口类型」（ComfyUI 风格）
  const PORT_COLOR_VAR: Record<string, string> = {
    text: 'var(--pt-text)',
    number: 'var(--pt-number)',
    boolean: 'var(--pt-boolean)',
    list: 'var(--pt-list)',
    json: 'var(--pt-json)',
    any: 'var(--sm-edge)',
  };
  const styledEdges = useMemo(() => {
    const outTypeByNode: Record<string, NodeDefinition> = {};
    for (const n of nodes) {
      const def = getNodeDef(n.data.typeId);
      if (def) outTypeByNode[n.id] = def;
    }
    return edges.map((e): Edge => {
      const def = outTypeByNode[e.source];
      const out = def?.outputs.find((o: { id: string }) => o.id === (e.sourceHandle ?? def.outputs[0]?.id));
      const pt = out?.type ?? 'any';
      const colorVar = PORT_COLOR_VAR[pt] ?? 'var(--sm-edge)';
      return { ...e, style: { ...(e.style ?? {}), ['--edge-color']: colorVar } } as Edge;
    });
  }, [nodes, edges]);

  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const toggleMinimap = useViewStore((s) => s.toggleMinimap);
  const interactionMode = useViewStore((s) => s.interactionMode);
  const setInteractionMode = useViewStore((s) => s.setInteractionMode);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();

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
      // 分栏工作流：拖入的节点加入本地副本（随后写回 workflows）
      if (isSplit) {
        const id = `n-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
        const def = getNodeDef(typeId);
        const params: Record<string, unknown> = {};
        for (const p of def?.params ?? []) if (p.default !== undefined) params[p.key] = p.default;
        setSplitNodes((ns) => [
          ...ns,
          {
            id,
            type: 'base',
            position: { x: position.x - 112, y: position.y - 20 },
            data: { typeId, label: def?.name ?? typeId, params, status: 'idle' as NodeStatus, dirty: true },
          },
        ]);
        return;
      }
      addNode(typeId, { x: position.x - 112, y: position.y - 20 });
    },
    [addNode, screenToFlowPosition, isSplit],
  );

  const setExamplesOpen = useWorkflowStore((s) => s.setExamplesOpen);
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);
  const newWorkflowInProject = useWorkflowStore((s) => s.newWorkflowInProject);
  // 仅当「标签页栏没有任何标签页」（项目内零工作流）时，画布背景显示欢迎卡片
  const workflowCount = useWorkflowStore((s) => Object.keys(s.workflows).length);

  // 关闭欢迎界面：新建一个空白工作流标签，进入正常编辑态
  const dismissWelcome = () => {
    newWorkflowInProject();
  };

  // 点击模板：新建一个工作流标签，并在该标签中打开模板
  const startTemplate = (id: string) => {
    const tpl = STARTER_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const { nodes: n, edges: e } = tpl.build();
    if (workflowCount === 0) newWorkflowInProject();
    loadGraph('示例 · ' + tpl.name, n, e, [], []);
  };

  const defaultEdgeOptions = useMemo(
    () => ({
      type: 'default' as const,
    }),
    [],
  );

  const noWorkflows = workflowCount === 0;
  const [zoomPct, setZoomPct] = useState(100);

  return (
    <div className="sm-canvas-dot relative h-full w-full" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={handleNodeClick}
        onPaneClick={() => setSelected(null, wfId)}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionLineType={ConnectionLineType.Bezier}
        deleteKeyCode={['Backspace', 'Delete']}
        // 中键（button 1）始终拖动画布；拖动模式下左键（button 0）也拖动画布
        panOnDrag={interactionMode === 'move' ? [0, 1] : [1]}
        selectionOnDrag={interactionMode === 'select'}
        selectionMode={interactionMode === 'select' ? SelectionMode.Partial : SelectionMode.Full}
        // 滚轮始终缩放画布（不平移），与鼠标模式无关
        panOnScroll={false}
        zoomOnScroll
        selectionKeyCode={null}
        multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
        nodesDraggable
        fitView
        onMoveEnd={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
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
        {/* 左下：鼠标模式切换 + 小地图开关（ComfyUI 风格） */}
        <Panel position="bottom-left" className="sm-cv-panel">
          <div className="sm-cv-modes">
            <button
              className={`sm-cv-btn ${interactionMode === 'move' ? 'active' : ''}`}
              title="拖动模式（拖动画布）"
              onClick={() => setInteractionMode('move')}
            >
              <Hand size={15} />
            </button>
            <button
              className={`sm-cv-btn ${interactionMode === 'select' ? 'active' : ''}`}
              title="框选模式（拖拽框选节点）"
              onClick={() => setInteractionMode('select')}
            >
              <BoxSelect size={15} />
            </button>
            <button
              className={`sm-cv-btn ${showMinimap ? 'active' : ''}`}
              title={showMinimap ? '隐藏小地图' : '显示小地图'}
              onClick={toggleMinimap}
            >
              <Map size={15} />
            </button>
          </div>
        </Panel>

        {/* 右下：缩放控制（ComfyUI 风格） */}
        <Panel position="bottom-right" className="sm-cv-panel">
          <div className="sm-cv-zoom">
            <button className="sm-cv-btn" title="缩小" onClick={() => zoomOut({ duration: 150 })}>
              <Minus size={15} />
            </button>
            <button className="sm-cv-zoom-val" title="适应视图" onClick={() => fitView({ duration: 250, padding: 0.2 })}>
              {zoomPct}%
            </button>
            <button className="sm-cv-btn" title="放大" onClick={() => zoomIn({ duration: 150 })}>
              <Plus size={15} />
            </button>
            <button className="sm-cv-btn" title="适应视图" onClick={() => fitView({ duration: 250, padding: 0.2 })}>
              <Maximize2 size={15} />
            </button>
          </div>
        </Panel>

        {showMinimap && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => CAT_COLORS[(n.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
            nodeStrokeColor={(n) => CAT_COLORS[(n.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
            maskColor="rgba(0,0,0,0.45)"
            style={{ marginBottom: 44 }}
          />
        )}
      </ReactFlow>

      {noWorkflows && !isSplit && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
          <div
            className="pointer-events-auto relative grid w-[720px] max-w-full grid-cols-1 gap-6 rounded-2xl border p-7 shadow-2xl md:grid-cols-[260px_1fr]"
            style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
          >
            <button
              className="absolute right-3 top-3 rounded-md p-1.5 transition-colors"
              style={{ color: 'var(--sm-ink-faint)' }}
              title="关闭"
              onClick={dismissWelcome}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sm-bg-soft)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={16} />
            </button>
            {/* 左：主操作区 */}
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <Sparkles size={18} style={{ color: 'var(--sm-accent)' }} />
                <h2 className="text-[18px] font-bold" style={{ color: 'var(--sm-ink)' }}>
                  slimeMold
                </h2>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
                把节点连成一条工作流，就能自动运行。从下面开始：
              </p>

              <div className="mt-4 flex flex-col gap-1.5">
                <button
                  onClick={() => newWorkflow()}
                  className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
                  style={{ color: 'var(--sm-ink)' }}
                >
                  <FilePlus2 size={16} style={{ color: 'var(--sm-accent)' }} />
                  新建工作流
                  <span className="ml-auto text-[11px] opacity-0 transition-opacity group-hover:opacity-60"
                    style={{ color: 'var(--sm-ink-faint)' }}>Ctrl/Cmd+N</span>
                </button>
                <button
                  onClick={() => setExamplesOpen(true)}
                  className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
                  style={{ color: 'var(--sm-ink)' }}
                >
                  <LayoutTemplate size={16} style={{ color: 'var(--sm-accent)' }} />
                  浏览示例库
                </button>
                <button
                  onClick={() => setExamplesOpen(true)}
                  className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
                  style={{ color: 'var(--sm-ink)' }}
                >
                  <FolderOpen size={16} style={{ color: 'var(--sm-accent)' }} />
                  打开已有工作流
                </button>
              </div>

              <p className="mt-auto pt-4 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
                左侧「节点库」可搜索全部节点；AI 节点默认开启离线模拟，无需配置即可试跑。
              </p>
            </div>

            {/* 右：示例模板 */}
            <div className="flex flex-col">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--sm-ink-faint)' }}>
                从模板开始
              </p>
              <div className="grid grid-cols-1 items-start gap-1.5 sm:grid-cols-2">
                {STARTER_TEMPLATES.slice(0, 6).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => startTemplate(t.id)}
                    className="group flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition hover:-translate-y-0.5"
                    style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--sm-accent-soft)';
                      e.currentTarget.style.background = 'color-mix(in srgb, var(--sm-accent) 6%, var(--sm-bg-soft))';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--sm-line)';
                      e.currentTarget.style.background = 'var(--sm-bg-soft)';
                    }}
                  >
                    <span className="text-[18px] leading-none">{t.emoji}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                        {t.name}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                        {t.desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setExamplesOpen(true)}
                className="mt-3 self-start text-[12px] font-medium underline-offset-2 hover:underline"
                style={{ color: 'var(--sm-accent)' }}
              >
                查看全部示例 →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
