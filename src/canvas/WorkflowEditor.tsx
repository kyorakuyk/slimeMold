import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
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
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import BaseNode from './nodes/BaseNode';
import GroupProxyNode from './nodes/GroupProxyNode';
import { KindEdge } from './KindEdge';
import GroupLayer from './GroupLayer';
import SubgraphEditor from './SubgraphEditor';
import { useRegistryStore } from '../store/registryStore';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import type { FlowEdge, FlowNode } from '../types/graph';
import JobBoard from '../components/JobBoard';
import Companion from '../components/Companion';
import { CanvasWfIdContext } from './canvasWfId';
import CanvasWelcomeSurface from './CanvasWelcomeSurface';
import CanvasPanelControls from './CanvasPanelControls';
import useCanvasGraphProjection from './useCanvasGraphProjection';
import useCanvasNodePicker from './useCanvasNodePicker';
import useCanvasContextMenu from './useCanvasContextMenu';
import useSplitWorkflowGraph from './useSplitWorkflowGraph';
import useRightBoxSelection from './useRightBoxSelection';
import useCanvasReconnect from './useCanvasReconnect';
import useCanvasDrop, { DND_MIME } from './useCanvasDrop';
import { canConnectEdges } from './connectValidation';
import { useT } from '../i18n/useT';

const nodeTypes: NodeTypes = { base: BaseNode, groupProxy: GroupProxyNode };
const edgeTypes = { kind: KindEdge };

export { DND_MIME };

/**
 * 画布外壳：决定该实例使用哪个 ReactFlowProvider。
 *
 * 背景：ReactFlowProvider 内部维护单一 store（节点尺寸测量、视口 transform、选中态等）。
 * 拆分视图会同时挂载两个 WorkflowEditor，若共用 App 层那一个 Provider，两个 ReactFlow
 * 实例会互相覆写彼此的内部状态，表现为「左右两栏显示同一张图」。
 *
 * 取舍：主画布（无 wfId）**继续复用 App 层 Provider**，这样 TopBar 的缩放/适配窗口、
 * NodePalette 的拖入坐标换算、GroupsPanel 的聚焦等外部面板的 useReactFlow() 仍作用于它；
 * 分栏画布（有 wfId）套一层自己的 Provider 与主画布隔离。
 */
export default function WorkflowEditor(props: { wfId?: string; onNewProject?: () => void; isActive?: boolean }) {
  if (!props.wfId) return <WorkflowEditorInner {...props} />;
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

/** 组合主画布与指定分栏 workflow 的 React Flow 交互，图投影和专用手势由子 hook 提供。
 * 节点/边变更按 `wfId` 路由到主 store actions 或 split-local setters，保持两种图上下文分离（ADR-SM-017、ADR-SM-072）。
 */
function WorkflowEditorInner({
  wfId,
  onNewProject,
  isActive = true,
}: {
  wfId?: string;
  onNewProject?: () => void;
  isActive?: boolean;
}) {
  const t = useT();
  // 无 wfId：渲染当前激活工作流（全局状态）；有 wfId：渲染并编辑指定工作流（拆分视图分栏）
  const isSplit = !!wfId;
  const { screenToFlowPosition, getNodes } = useReactFlow();
  const activeNodes = useWorkflowStore((s) => s.nodes);
  const activeEdges = useWorkflowStore((s) => s.edges);
  const splitWf = useWorkflowStore((s) => (wfId ? s.workflows[wfId] : undefined));
  const updateWorkflowGraph = useWorkflowStore((s) => s.updateWorkflowGraph);
  const storeOnNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const storeOnEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const storeOnConnect = useWorkflowStore((s) => s.onConnect);
  const addNode = useWorkflowStore((s) => s.addNode);
  const setSelected = useWorkflowStore((s) => s.setSelected);
  const setSelectedIds = useWorkflowStore((s) => s.setSelectedIds);
  // 右键框选的状态、refs 与全局监听由 useRightBoxSelection 拥有（suppressSelectionSync 供选区同步使用）
  const { rightBox, rightStart, rightMovedRef, suppressSelectionSync, onPaneMouseDownCapture } =
    useRightBoxSelection({ screenToFlowPosition, getNodes, isSplit, wfId });
  // 分栏工作流的图状态与「载入 ↔ 写回」双向同步由 useSplitWorkflowGraph 拥有
  const { splitNodes, splitEdges, setSplitNodes, setSplitEdges } = useSplitWorkflowGraph({
    isSplit,
    wfId,
    splitWf,
    updateWorkflowGraph,
  });
  // 把 React Flow 当前选中的节点 id 集合写入 store，供对齐/分布使用
  // （原实现依赖节点瞬态 selected 字段，拆分视图右栏的运行态节点不会被同步，导致全图误选堆叠）
  const onSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: FlowNode[] }) => {
      // 右键框选期间不写入，避免覆盖框选结果
      if (suppressSelectionSync.current) return;
      // 仅维护 selectedIds 供对齐/分布使用；不回写节点 selected，避免与受控渲染形成无限循环
      setSelectedIds(selNodes.map((n) => n.id));
    },
    [setSelectedIds],
  );
  const groups = useWorkflowStore((s) => s.groups);
  const allDefs = useRegistryStore((s) => s.defs);
  const subgraphs = useWorkflowStore((s) => s.subgraphs);
  const focusedSubgraphId = useViewStore((s) => s.focusedSubgraphId);
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);
  const { nodes, edges, styledEdges } = useCanvasGraphProjection({
    isSplit,
    activeNodes,
    activeEdges,
    splitNodes,
    splitEdges,
    groups,
    allDefs,
    subgraphs,
  });

  const onNodesChange: OnNodesChange<FlowNode> = isSplit
    ? (changes) => setSplitNodes((ns) => applyNodeChanges(changes, ns))
    : storeOnNodesChange;
  const onEdgesChange: OnEdgesChange<FlowEdge> = isSplit
    ? (changes) => setSplitEdges((es) => applyEdgeChanges(changes, es))
    : storeOnEdgesChange;
  const onConnect: (conn: Connection) => void = isSplit
    ? (conn) =>
        setSplitEdges((es) =>
          addEdge({ ...conn, id: `e-${conn.source}-${conn.target}-${Date.now()}`, type: 'kind', data: { kind: 'data' } }, es),
        )
    : storeOnConnect;

  // 重新连线：环路/类型校验与「主画布写 store / 分栏写本地副本」的分支由 useCanvasReconnect 拥有
  const onReconnect = useCanvasReconnect({ isSplit, nodes, setSplitEdges, t });

  const handleNodeClick = useCallback(
    (_: unknown, node: FlowNode) => setSelected(node.id, wfId),
    [setSelected, wfId],
  );


  const interactionMode = useViewStore((s) => s.interactionMode);
  const setInteractionMode = useViewStore((s) => s.setInteractionMode);

  // 连线时的友好预校验：环路或端口类型不兼容时，手柄直接显示不可连接
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => canConnectEdges({ conn, edges, nodes, allDefs, subgraphs }),
    [edges, nodes, allDefs, subgraphs],
  );

  const addSubgraphRef = useWorkflowStore((s) => s.addSubgraphRefNode);

  // 画布 drop（普通节点写 store / 子图引用 / 分栏写本地副本）由 useCanvasDrop 拥有
  const onDrop = useCanvasDrop({ isSplit, addNode, addSubgraphRef, setSplitNodes, screenToFlowPosition });

  // 仅当「标签页栏没有任何标签页」（项目内零工作流）时，画布背景显示欢迎卡片
  const workflowCount = useWorkflowStore((s) => Object.keys(s.workflows).length);

  // 关闭欢迎界面：仅隐藏（不再自动新建工作流标签），背景退回纯色空态
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const dismissWelcome = () => {
    setWelcomeDismissed(true);
  };


  const defaultEdgeOptions = useMemo(
    () => ({
      type: 'kind' as const,
    }),
    [],
  );

  const noWorkflows = workflowCount === 0;
  const [zoomPct, setZoomPct] = useState(100);

  const nodePicker = useCanvasNodePicker({ isSplit, isActive, addNode, addSubgraphRef });
  const contextMenu = useCanvasContextMenu({ nodes, isSplit, noWorkflows, rightMovedRef });

  // 鼠标模式：click=仅点击选中（左键不平移画布、不框选）；move=拖动；select=框选
  const selectionOnDrag = interactionMode === 'select';
  const panOnDrag: number[] = interactionMode === 'move' ? [0, 1] : [1];

  return (
    <CanvasWfIdContext.Provider value={isSplit ? wfId : undefined}>
    <div
      className="sm-pro-canvas sm-canvas-dot relative h-full w-full"
      onDrop={onDrop}
      onDragOverCapture={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onMouseDownCapture={onPaneMouseDownCapture}
      onDoubleClick={nodePicker.onCanvasDoubleClick}
    >
      {!noWorkflows && (
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onConnectEnd={nodePicker.onConnectEnd}
        isValidConnection={isValidConnection}
        onSelectionChange={onSelectionChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'groupProxy') {
            const gid = (node.data as { group?: { subgraphId?: string } })?.group?.subgraphId;
            if (gid) setFocusedSubgraph(gid);
            return;
          }
          // 从「我的子图」库拖出的子图引用节点也支持双击进入编辑
          if (node.data?.typeId === SUBGRAPH_REF_TYPE) {
            const gid = String(node.data?.params?.subgraphId ?? '');
            if (gid) setFocusedSubgraph(gid);
            return;
          }
          // 双击普通节点：选中它并展开右侧 Inspector 展示详细信息
          setSelected(node.id);
          if (!inspectorOpen) toggleInspector();
        }}
        onPaneClick={() => {
          setSelected(null, wfId);
          // 清理可能残留的右键框选标记，避免 window mousemove 监听常驻导致持续重渲染（卡死）
          rightStart.current = null;
          rightMovedRef.current = false;
          suppressSelectionSync.current = false;
          // 点击空白处取消选区：清空当前工作区节点高亮与 selectedIds
          const st = useWorkflowStore.getState();
          if (isSplit && wfId) {
            const wf = st.workflows[wfId];
            if (wf) {
              useWorkflowStore.setState({
                workflows: { ...st.workflows, [wfId]: { ...wf, nodes: wf.nodes.map((nd) => ({ ...nd, selected: false })) } },
                selectedIds: [],
              });
            }
          } else {
            useWorkflowStore.setState({
              nodes: st.nodes.map((nd) => ({ ...nd, selected: false })),
              selectedIds: [],
            });
          }
        }}
        zoomOnDoubleClick={false}
        onNodeContextMenu={contextMenu.onNodeContextMenu}
        onPaneContextMenu={contextMenu.onPaneContextMenu}
        onSelectionContextMenu={contextMenu.onSelectionContextMenu}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionLineType={ConnectionLineType.Bezier}
        // 子图编辑视图打开时，父图 ReactFlow 实例仍需挂载（作为兄弟节点），
        // 但其 deleteKeyCode 监听挂在 document 上会与子图实例冲突（误删分组）。
        // 因此子图打开期间临时禁用父图删除快捷键，交由其内部实例处理。
        deleteKeyCode={focusedSubgraphId ? null : ['Backspace', 'Delete']}
        // 中键（button 1）始终拖动画布；右键长按（rightSelecting）时仅中键平移，左键用于框选
        panOnDrag={panOnDrag}
        selectionOnDrag={selectionOnDrag}
        selectionMode={selectionOnDrag ? SelectionMode.Partial : SelectionMode.Full}
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
        <CanvasPanelControls
          wfId={wfId}
          zoomPct={zoomPct}
          interactionMode={interactionMode}
          onInteractionModeChange={setInteractionMode}
        />
      </ReactFlow>
      )}

      {/* 节点组框（纯视觉 overlay，置于 React Flow 之上，仅标题条可交互） */}
      {!noWorkflows && !isSplit && <GroupLayer />}

      {contextMenu.overlay}

      {noWorkflows && !isSplit && (
        <CanvasWelcomeSurface
          onNewProject={onNewProject}
          welcomeDismissed={welcomeDismissed}
          onDismiss={dismissWelcome}
          onShowWelcome={() => setWelcomeDismissed(false)}
          workflowCount={workflowCount}
        />
      )}

      {rightBox && (
        <div
          className="pointer-events-none fixed z-30 border border-sky-400 bg-sky-400/10"
          style={{
            left: Math.min(rightBox.x0, rightBox.x1),
            top: Math.min(rightBox.y0, rightBox.y1),
            width: Math.abs(rightBox.x1 - rightBox.x0),
            height: Math.abs(rightBox.y1 - rightBox.y0),
          }}
        />
      )}



      {/* 双击折叠组进入的子图编辑视图（Q5=D） */}
      {!isSplit && focusedSubgraphId && <SubgraphEditor subgraphId={focusedSubgraphId} />}

      {nodePicker.pickerOverlay}

      {/* 运行期调度看板（Job Board）：浮于画布右上角 */}
      <JobBoard wfId={wfId} />
      {/* Companion 浮窗：常驻状态球，仅主画布渲染（全局浮窗），避免与右栏重复；右栏运行态由 JobBoard 体现 */}
      {!wfId && <Companion />}
    </div>
    </CanvasWfIdContext.Provider>
  );
}
