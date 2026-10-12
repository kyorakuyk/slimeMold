import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { getNodeDef, useRegistryStore } from '../store/registryStore';
import { resolvePorts, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { arePortsCompatible, type EdgeKind, type FlowEdge, type FlowNode, type NodeStatus } from '../types/graph';
import { wouldCreateCycle } from '../engine/topoSort';
import JobBoard from '../components/JobBoard';
import Companion from '../components/Companion';
import { CanvasWfIdContext } from './canvasWfId';
import CanvasWelcomeSurface from './CanvasWelcomeSurface';
import CanvasPanelControls from './CanvasPanelControls';
import useCanvasGraphProjection from './useCanvasGraphProjection';
import useCanvasNodePicker from './useCanvasNodePicker';
import useCanvasContextMenu from './useCanvasContextMenu';
import { useT } from '../i18n/useT';

const nodeTypes: NodeTypes = { base: BaseNode, groupProxy: GroupProxyNode };
const edgeTypes = { kind: KindEdge };

export const DND_MIME = 'application/x-slime-node';

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
export default function WorkflowEditor(props: { wfId?: string; onNewProject?: () => void }) {
  if (!props.wfId) return <WorkflowEditorInner {...props} />;
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowEditorInner({
  wfId,
  onNewProject,
}: {
  wfId?: string;
  onNewProject?: () => void;
}) {
  const t = useT();
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
  const setSelectedIds = useWorkflowStore((s) => s.setSelectedIds);
  // 分栏工作流：以本地状态维护其图，编辑时写回 workflows 字典
  const [splitNodes, setSplitNodes] = useState<FlowNode[]>([]);
  const [splitEdges, setSplitEdges] = useState<FlowEdge[]>([]);
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
  // ---- 拆分视图右栏：载入 effect ↔ 写回 effect 双向同步 ----
  // 采用「内容指纹」而非引用比较来切断循环：
  // 载入 effect 依赖 splitWf，写回 effect 依赖 splitNodes，二者在同一 commit 中按声明顺序执行，
  // 若用「引用是否相等」判断回流，载入 effect 先跑时会看到旧 splitWf 而误判外部变化，反复重载导致
  // 「写回 → splitWf 变 → 重载 → 又写回」无限循环（曾导致拆分视图拖拽即卡死）。
  // 指纹是「节点/连线的关键字段序列化」，内容级比较与执行顺序无关，能精准区分「自身回流」与「外部真修改」。
  const splitSigRef = useRef<string | null>(null);
  const splitSig = (ns: FlowNode[], es: FlowEdge[]) =>
    JSON.stringify([
      ns.map((n) => [n.id, n.position.x, n.position.y, n.data?.typeId, n.data?.params ?? null]),
      es.map((e) => [e.id, e.source, e.sourceHandle ?? null, e.target, e.targetHandle ?? null]),
    ]);
  // 标记「当前 wfId 的图是否已从 store 载入本地状态」。
  // 未载入前禁止写回：挂载首帧 splitNodes 还是初始空数组，此时写回会把目标工作流清空。
  const loadedWfIdRef = useRef<string | null>(null);
  // 先于载入 effect 重置目标标记；否则同指纹的新 wfId 会在载入 effect 中被误判为已同步。
  useEffect(() => {
    if (loadedWfIdRef.current !== wfId) splitSigRef.current = null;
  }, [wfId]);

  useEffect(() => {
    if (!isSplit || !splitWf || !wfId) return;
    const srcNodes = splitWf.nodes ?? [];
    const srcEdges = splitWf.edges ?? [];
    const sig = splitSig(srcNodes, srcEdges);
    // 内容与本地已同步（含自身写回回流、重复载入）→ 跳过
    if (splitSigRef.current === sig) return;
    // 方案 P：splitWf.nodes 已是运行态 FlowNode，直接复用
    const loadedNodes = srcNodes.map((n) => ({ ...n, data: { ...n.data, dirty: true } }));
    const loadedEdges = srcEdges.map((e) => ({ ...e }));
    splitSigRef.current = sig;
    loadedWfIdRef.current = wfId;
    setSplitNodes(loadedNodes);
    setSplitEdges(loadedEdges);
  }, [isSplit, wfId, splitWf]);

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

  // 重新连线：拖拽已有连线的一端到新端口，更新该连线端点（带环路/类型校验）
  const onReconnect = useCallback(
    (oldEdge: FlowEdge, conn: Connection) => {
      const st = useWorkflowStore.getState();
      const newSource = conn.source ?? oldEdge.source;
      const newTarget = conn.target ?? oldEdge.target;
      const newSH = conn.sourceHandle ?? oldEdge.sourceHandle;
      const newTH = conn.targetHandle ?? oldEdge.targetHandle;

      // 环路校验（与 onConnect 一致，忽略 control 语义）
      if (wouldCreateCycle(newSource, newTarget, st.edges.filter((e) => e.id !== oldEdge.id))) {
        st.addLog('error', t('canvas.reconnect.cycleCancelled'));
        return;
      }
      // 端口类型校验
      const srcNode = nodes.find((n) => n.id === newSource);
      const tgtNode = nodes.find((n) => n.id === newTarget);
      const sgs = st.subgraphs;
      const defs = useRegistryStore.getState().defs;
      const srcDef = resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, defs, sgs);
      const tgtDef = resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, defs, sgs);
      const srcPort = srcDef.outputs.find((o) => o.id === newSH);
      const tgtPort = tgtDef.inputs.find((i) => i.id === newTH);
      if (!arePortsCompatible(srcPort?.type, tgtPort?.type)) {
        st.addLog('error', t('canvas.reconnect.typeMismatch'));
        return;
      }
      const kind = (srcPort?.flow as EdgeKind | undefined) ?? (oldEdge.data?.kind as EdgeKind) ?? 'data';
      const updated: FlowEdge = {
        ...oldEdge,
        source: newSource,
        target: newTarget,
        sourceHandle: newSH ?? undefined,
        targetHandle: newTH ?? undefined,
        data: { ...(oldEdge.data ?? {}), kind },
      };
      if (isSplit) {
        setSplitEdges((es) => es.map((e) => (e.id === oldEdge.id ? updated : e)));
      } else {
        st.pushHistory();
        useWorkflowStore.setState({ edges: st.edges.map((e) => (e.id === oldEdge.id ? updated : e)) });
        st.markDirty(newSource);
      }
    },
    [isSplit, nodes, setSplitEdges],
  );

  // 分栏编辑时，把最新图写回 store。
  // 两道闸门：
  // 1) loadedWfIdRef !== wfId —— 尚未从 store 载入，此时 splitNodes 是初始空数组，
  //    写回会把目标工作流清空（曾导致分栏目标工作流节点全丢）。
  // 2) 内容指纹与上次写回/载入一致 —— 说明没有用户编辑，跳过以切断
  //    「加载 effect ↔ 写回 effect」死循环（曾打爆 WebView2）。
  useEffect(() => {
    if (!isSplit || !wfId) return;
    if (loadedWfIdRef.current !== wfId) return;
    const sig = splitSig(splitNodes, splitEdges);
    if (splitSigRef.current === sig) return;
    splitSigRef.current = sig;
    updateWorkflowGraph(wfId, splitNodes, splitEdges);
  }, [isSplit, wfId, splitNodes, splitEdges, updateWorkflowGraph]);

  const handleNodeClick = useCallback(
    (_: unknown, node: FlowNode) => setSelected(node.id, wfId),
    [setSelected, wfId],
  );


  const interactionMode = useViewStore((s) => s.interactionMode);
  const setInteractionMode = useViewStore((s) => s.setInteractionMode);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  // 右键长按框选：按住右键拖动在画布上画矩形，命中节点高亮；短按则弹右键菜单
  const [rightBox, setRightBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rightStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // 右键框选是否发生移动：在 mouseup 时落定，供紧随其后的 contextmenu 判断（避免 mouseup 清 rightStart 导致误弹菜单）
  const rightMovedRef = useRef(false);
  // 右键框选 drag 期间抑制 React Flow 的 onSelectionChange 写入，避免把框选刚设的 selectedIds 清空
  const suppressSelectionSync = useRef(false);
  // 框选上一帧命中集合（join 后的 key），仅当命中真正变化时才写回 store，
  // 避免每帧 mousemove 都重写整个 nodes 数组（曾导致多次交互后卡死）
  const lastHitRef = useRef<string | null>(null);
  const onPaneMouseDownCapture = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return; // 仅右键
    e.preventDefault();
    rightStart.current = { x: e.clientX, y: e.clientY, moved: false };
    suppressSelectionSync.current = true; // 框选期间抑制 React Flow 选区回写，避免清空 selectedIds
    setRightBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }, []);
  // 供框选 effect 读取的最新值（避免 effect 依赖频繁重建导致监听器叠加）
  const latestRef = useRef({ screenToFlowPosition, getNodes, isSplit, wfId });
  latestRef.current = { screenToFlowPosition, getNodes, isSplit, wfId };

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      const rs = rightStart.current;
      if (!rs) return;
      // 自愈：右键已松开却未收到 mouseup（如拖出窗口外松手、菜单拦截、焦点切换），
      // 主动清理，避免 残留的 rightStart 让后续任意 mousemove（含左键拖节点）持续重写 nodes 数组而致卡死。
      if (!(ev.buttons & 2)) {
        rightStart.current = null;
        suppressSelectionSync.current = false;
        rightMovedRef.current = false;
        setRightBox(null);
        lastHitRef.current = null;
        return;
      }
      if (Math.abs(ev.clientX - rs.x) + Math.abs(ev.clientY - rs.y) > 4) {
        rs.moved = true;
      }
      setRightBox((b) => (b ? { ...b, x1: ev.clientX, y1: ev.clientY } : b));
      const { screenToFlowPosition, getNodes, isSplit, wfId } = latestRef.current;
      const sx = Math.min(rs.x, ev.clientX);
      const sy = Math.min(rs.y, ev.clientY);
      const ex = Math.max(rs.x, ev.clientX);
      const ey = Math.max(rs.y, ev.clientY);
      const tl = screenToFlowPosition({ x: sx, y: sy });
      const br = screenToFlowPosition({ x: ex, y: ey });
      const hit = getNodes()
        .filter((n) => {
          const w = n.measured?.width ?? 160;
          const h = n.measured?.height ?? 70;
          return n.position.x < br.x && n.position.x + w > tl.x && n.position.y < br.y && n.position.y + h > tl.y;
        })
        .map((n) => n.id);
      // 命中集合未变化则跳过整段 store 写入，避免每帧重写整个 nodes 数组（卡死根因之一）
      const hitKey = hit.join(',');
      if (hitKey === lastHitRef.current) return;
      lastHitRef.current = hitKey;
      // 框选命中后：同步选中态到正确的节点列表（拆分视图写右栏运行态副本，否则写主工作区），
      // 并写入 selectedIds / selectedNodeId / focusWfId，供对齐、分布、Inspector 等消费。
      const st = useWorkflowStore.getState();
      if (isSplit && wfId) {
        const wf = st.workflows[wfId];
        if (wf) {
          useWorkflowStore.setState({
            workflows: {
              ...st.workflows,
              [wfId]: { ...wf, nodes: wf.nodes.map((nd) => ({ ...nd, selected: hit.includes(nd.id) })) },
            },
            selectedIds: hit,
            selectedNodeId: hit[0] ?? null,
            focusWfId: wfId,
          });
        }
      } else {
        useWorkflowStore.setState({
          nodes: st.nodes.map((nd) => ({ ...nd, selected: hit.includes(nd.id) })),
          selectedIds: hit,
          selectedNodeId: hit[0] ?? null,
          focusWfId: st.activeWfId,
        });
      }
    };
    const onUp = () => {
      setRightBox(null);
      // mouseup 先于 contextmenu：落定 moved 标记并清理 rightStart，避免残留导致 window mousemove 常驻重渲染（卡死）
      rightMovedRef.current = rightStart.current?.moved ?? false;
      rightStart.current = null;
      suppressSelectionSync.current = false;
      lastHitRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 鼠标移出窗口/失焦时（mouseup 可能不触发）强制清理框选标记，避免残留导致常驻重渲染
    const onBlur = () => {
      rightStart.current = null;
      rightMovedRef.current = false;
      suppressSelectionSync.current = false;
      setRightBox(null);
      lastHitRef.current = null;
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // 连线时的友好预校验：环路或端口类型不兼容时，手柄直接显示不可连接
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target) return false;
      if (conn.source === conn.target) return false;
      if (wouldCreateCycle(conn.source, conn.target, edges)) return false;
      // 端口须按节点实例解析：子图节点的端口来自其引用的子图定义
      const srcNode = nodes.find((n) => n.id === conn.source);
      const tgtNode = nodes.find((n) => n.id === conn.target);
      const srcDef = resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, allDefs, subgraphs);
      const tgtDef = resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, allDefs, subgraphs);
      const srcPort = srcDef.outputs.find((o) => o.id === conn.sourceHandle);
      const tgtPort = tgtDef.inputs.find((i) => i.id === conn.targetHandle);
      return arePortsCompatible(srcPort?.type, tgtPort?.type);
    },
    [edges, nodes, allDefs, subgraphs],
  );

  const addSubgraphRef = useWorkflowStore((s) => s.addSubgraphRefNode);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const typeId = e.dataTransfer.getData(DND_MIME) || e.dataTransfer.getData('text/plain');
      if (!typeId) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 子图载荷格式：`subgraph.ref:<子图 id>`
      if (typeId.startsWith(`${SUBGRAPH_REF_TYPE}:`)) {
        if (isSplit) return;
        addSubgraphRef(typeId.slice(SUBGRAPH_REF_TYPE.length + 1), {
          x: position.x - 112,
          y: position.y - 20,
        });
        return;
      }
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
    [addNode, screenToFlowPosition, isSplit, addSubgraphRef],
  );

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

  const nodePicker = useCanvasNodePicker({ isSplit, addNode, addSubgraphRef });
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
