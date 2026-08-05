import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type FinalConnectionState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LayoutTemplate, FolderPlus, FolderOpen, Sparkles, X, Hand, BoxSelect, Map as MapIcon, Minus, Plus, Maximize2, Boxes, Group, Ungroup, MousePointer2, AlignStartVertical, AlignEndVertical, AlignCenterVertical, AlignStartHorizontal, AlignEndHorizontal, AlignCenterHorizontal, AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import BaseNode from './nodes/BaseNode';
import GroupProxyNode from './nodes/GroupProxyNode';
import { KindEdge } from './KindEdge';
import GroupLayer from './GroupLayer';
import SubgraphEditor from './SubgraphEditor';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { getNodeDef, useRegistryStore } from '../store/registryStore';
import { resolvePorts, SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { arePortsCompatible, type PortDef, type FlowNode, type FlowEdge, type NodeStatus, type EdgeKind } from '../types';
import { wouldCreateCycle } from '../engine/topoSort';
import { NamePrompt } from '../components/NamePrompt';
import { NodePickerModal, type PickPayload } from '../components/NodePickerModal';
import JobBoard from '../components/JobBoard';
import Companion from '../components/Companion';

const nodeTypes: NodeTypes = { base: BaseNode, groupProxy: GroupProxyNode };
const edgeTypes = { kind: KindEdge };

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

export default function WorkflowEditor({
  wfId,
  onNewProject,
}: {
  wfId?: string;
  onNewProject?: () => void;
}) {
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
  const alignSelected = useWorkflowStore((s) => s.alignSelected);
  const distributeSelected = useWorkflowStore((s) => s.distributeSelected);

  // 分栏工作流：以本地状态维护其图，编辑时写回 workflows 字典
  const [splitNodes, setSplitNodes] = useState<FlowNode[]>([]);
  const [splitEdges, setSplitEdges] = useState<FlowEdge[]>([]);
  useEffect(() => {
    if (!isSplit || !splitWf) return;
    // 方案 P：splitWf.nodes 已是运行态 FlowNode，直接复用
    setSplitNodes((splitWf.nodes ?? []).map((n) => ({ ...n, data: { ...n.data, dirty: true } })));
    setSplitEdges((splitWf.edges ?? []).map((e) => ({ ...e })));
  }, [isSplit, splitWf]);

  const groups = useWorkflowStore((s) => s.groups);
  const focusedSubgraphId = useViewStore((s) => s.focusedSubgraphId);
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);
  // grpnode_* 是折叠组的派生代理节点，只由本组件生成，不应出现在 store.nodes 里。
  // 兜底过滤一层，防止历史数据（早期版本误写入）把组当成普通节点。
  const rawNodes = isSplit ? splitNodes : activeNodes.filter((n) => !n.id.startsWith('grpnode_'));
  const edges = isSplit ? splitEdges : activeEdges;

  // 折叠的节点组：其成员节点在画布上隐藏（仅保留组代理节点）
  const hiddenByGroup = useMemo(() => {
    if (isSplit) return new Set<string>();
    const s = new Set<string>();
    for (const g of groups) if (g.collapsed) for (const id of g.nodeIds) s.add(id);
    return s;
  }, [groups, isSplit]);

  // 折叠分组 -> 代理节点：左右按类型聚合生成虚拟端口，作为 React Flow 节点
  const groupProxyNodes = useMemo<FlowNode[]>(() => {
    if (isSplit) return [];
    const out: FlowNode[] = [];
    for (const g of groups) {
      if (!g.collapsed) continue;
      // 折叠态位置：优先用记录的包围盒，否则按成员位置估算
      let x = g.bounds?.x ?? 0;
      let y = g.bounds?.y ?? 0;
      let w = g.bounds?.width ?? 200;
      if (g.bounds == null && g.nodeIds.length) {
        const ms = rawNodes.filter((n) => g.nodeIds.includes(n.id));
        if (ms.length) {
          x = Math.min(...ms.map((n) => n.position.x));
          y = Math.min(...ms.map((n) => n.position.y));
          w = 200;
        }
      }
      out.push({
        id: `grpnode_${g.id}`,
        type: 'groupProxy',
        position: { x, y },
        data: { group: g, box: { x, y, width: w, height: 60 } },
        selected: g.nodeIds.some((id) => rawNodes.find((n) => n.id === id)?.selected),
      } as unknown as FlowNode);
    }
    return out;
  }, [groups, rawNodes, isSplit]);

  // 折叠组：成员 -> 代理端口 handle 映射（用于重定向外部连线）
  const memberToProxy = useMemo(() => {
    const map = new Map<string, { nodeId: string; handle: string; type: string }>();
    for (const g of groups) {
      if (!g.collapsed || !g.proxyPorts) continue;
      for (const p of g.proxyPorts) {
        const nodeId = `grpnode_${g.id}`;
        for (const t of p.internalTargets) {
          map.set(t.nodeId, { nodeId, handle: p.id, type: p.kind });
        }
      }
    }
    return map;
  }, [groups]);

  const nodes = useMemo(() => {
    const base =
      hiddenByGroup.size === 0
        ? rawNodes
        : rawNodes.map((n) => (hiddenByGroup.has(n.id) ? { ...n, hidden: true } : n));
    return [...base, ...groupProxyNodes];
  }, [rawNodes, hiddenByGroup, groupProxyNodes]);

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
        st.addLog('error', '重新连线会形成环路，已取消');
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
        st.addLog('error', '重新连线失败：端口类型不兼容');
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

  // 分栏编辑时，把最新图写回 store
  useEffect(() => {
    if (!isSplit || !wfId) return;
    updateWorkflowGraph(wfId, splitNodes, splitEdges);
  }, [isSplit, wfId, splitNodes, splitEdges, updateWorkflowGraph]);

  const handleNodeClick = useCallback(
    (_: unknown, node: FlowNode) => setSelected(node.id, wfId),
    [setSelected, wfId],
  );

  const allDefs = useRegistryStore((s) => s.defs);
  const subgraphs = useWorkflowStore((s) => s.subgraphs);

  // 数据流向可视化：连线颜色跟随「源端口类型」（ComfyUI 风格）
  const PORT_COLOR_VAR: Record<string, string> = {
    text: 'var(--pt-text)',
    number: 'var(--pt-number)',
    boolean: 'var(--pt-boolean)',
    list: 'var(--pt-list)',
    json: 'var(--pt-json)',
    image: 'var(--pt-image)',
    any: 'var(--sm-edge)',
  };
  const styledEdges = useMemo(() => {
    // 按节点实例解析端口（子图节点的端口是动态的）
    const outsByNode: Record<string, PortDef[]> = {};
    for (const n of nodes) {
      outsByNode[n.id] = resolvePorts(n.data.typeId, n.data.params, allDefs, subgraphs).outputs;
    }
    return edges.map((e): Edge => {
      // 折叠组成员端点重定向到分组代理节点（外部多对一）
      let src = e.source;
      let srcH = e.sourceHandle ?? undefined;
      let tgt = e.target;
      let tgtH = e.targetHandle ?? undefined;
      const sm = memberToProxy.get(e.source);
      if (sm && sm.type === 'output') {
        src = sm.nodeId;
        srcH = sm.handle;
      }
      const tm = memberToProxy.get(e.target);
      if (tm && tm.type === 'input') {
        tgt = tm.nodeId;
        tgtH = tm.handle;
      }
      const outs = outsByNode[src] ?? [];
      const out = outs.find((o) => o.id === (srcH ?? outs[0]?.id));
      const pt = out?.type ?? 'any';
      const colorVar = PORT_COLOR_VAR[pt] ?? 'var(--sm-edge)';
      return { ...e, source: src, sourceHandle: srcH, target: tgt, targetHandle: tgtH, style: { ...(e.style ?? {}), ['--edge-color']: colorVar } } as Edge;
    });
  }, [nodes, edges, allDefs, subgraphs, memberToProxy]);

  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const toggleMinimap = useViewStore((s) => s.toggleMinimap);
  const interactionMode = useViewStore((s) => s.interactionMode);
  const setInteractionMode = useViewStore((s) => s.setInteractionMode);
  const { screenToFlowPosition, getNodes, zoomIn, zoomOut, fitView } = useReactFlow();

  // 右键长按框选：按住右键拖动在画布上画矩形，命中节点高亮；短按则弹右键菜单
  const [rightBox, setRightBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rightStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPaneMouseDownCapture = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return; // 仅右键
    e.preventDefault();
    rightStart.current = { x: e.clientX, y: e.clientY, moved: false };
    setRightBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }, []);
  useEffect(() => {
    if (!rightStart.current) return;
    const onMove = (ev: MouseEvent) => {
      if (!rightStart.current) return;
      if (Math.abs(ev.clientX - rightStart.current.x) + Math.abs(ev.clientY - rightStart.current.y) > 4) {
        rightStart.current.moved = true;
      }
      setRightBox((b) => (b ? { ...b, x1: ev.clientX, y1: ev.clientY } : b));
      const sx = Math.min(rightStart.current.x, ev.clientX);
      const sy = Math.min(rightStart.current.y, ev.clientY);
      const ex = Math.max(rightStart.current.x, ev.clientX);
      const ey = Math.max(rightStart.current.y, ev.clientY);
      const tl = screenToFlowPosition({ x: sx, y: sy });
      const br = screenToFlowPosition({ x: ex, y: ey });
      const hit = getNodes()
        .filter((n) => {
          const w = n.measured?.width ?? 160;
          const h = n.measured?.height ?? 70;
          return n.position.x < br.x && n.position.x + w > tl.x && n.position.y < br.y && n.position.y + h > tl.y;
        })
        .map((n) => n.id);
      useWorkflowStore.setState((st) => ({ nodes: st.nodes.map((nd) => ({ ...nd, selected: hit.includes(nd.id) })) }));
    };
    const onUp = () => setRightBox(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [rightBox, screenToFlowPosition]);

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

  const setExamplesOpen = useWorkflowStore((s) => s.setExamplesOpen);
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);
  const newWorkflowInProject = useWorkflowStore((s) => s.newWorkflowInProject);
  // 仅当「标签页栏没有任何标签页」（项目内零工作流）时，画布背景显示欢迎卡片
  const workflowCount = useWorkflowStore((s) => Object.keys(s.workflows).length);

  // 关闭欢迎界面：仅隐藏（不再自动新建工作流标签），背景退回纯色空态
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const dismissWelcome = () => {
    setWelcomeDismissed(true);
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
      type: 'kind' as const,
    }),
    [],
  );

  const noWorkflows = workflowCount === 0;
  const [zoomPct, setZoomPct] = useState(100);

  /* ---------- 画布右键菜单：打包为子图 / 编组 ---------- */
  const packAsSubgraph = useWorkflowStore((s) => s.packSelectionAsSubgraph);
  const createGroup = useWorkflowStore((s) => s.createGroup);
  const unpackSubgraph = useWorkflowStore((s) => s.unpackSubgraphNode);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId?: string } | null>(null);
  // 右键时的选中节点：React Flow 的多选状态记录在 node.selected 上
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => closeMenu();
    window.addEventListener('click', onDown);
    window.addEventListener('contextmenu', onDown);
    return () => {
      window.removeEventListener('click', onDown);
      window.removeEventListener('contextmenu', onDown);
    };
  }, [menu, closeMenu]);

  /** 右键目标节点未被选中时，把它视为唯一选区 */
  const targetIds = useMemo(() => {
    if (!menu) return [];
    if (menu.nodeId && !selectedIds.includes(menu.nodeId)) return [menu.nodeId];
    return selectedIds;
  }, [menu, selectedIds]);

  const menuRefNode = menu?.nodeId
    ? nodes.find((n) => n.id === menu.nodeId && n.data.typeId === SUBGRAPH_REF_TYPE)
    : undefined;

  const [packPrompt, setPackPrompt] = useState(false);
  const handlePack = () => {
    closeMenu();
    if (targetIds.length === 0) return;
    setPackPrompt(true);
  };
  const handleGroup = () => {
    closeMenu();
    if (targetIds.length === 0) return;
    createGroup(targetIds);
  };

  // 仿 ComfyUI：双击空白画布弹出节点选择窗口；Ctrl+K / Ctrl+Space 也可唤起（命令面板式，落于屏幕中心）
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  // 从端口拖拽到空白处建节点时，先缓存源端口上下文，待用户在命令面板选好节点后自动连边
  const pendingConn = useRef<{
    fromNodeId: string;
    fromHandleId: string;
    fromType: 'source' | 'target';
    screen: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key.toLowerCase() === 'k' || e.code === 'Space')) {
        // 避免在输入框/文本域中误触发
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        // 落点取屏幕中心，使新节点出现在当前视图中央
        setPickerPos({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!pickerPos) return;
    // 弹窗内部已 stopPropagation，外部点击冒泡到此关闭
    const onDocDown = () => setPickerPos(null);
    window.addEventListener('mousedown', onDocDown);
    return () => window.removeEventListener('mousedown', onDocDown);
  }, [pickerPos]);

  const onCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    // 只有双击空白画布（非节点/边/控制条/端口等）才弹出节点选择窗
    if (el.closest('.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .react-flow__panel, .react-flow__handle')) {
      return;
    }
    setPickerPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onPickNode = useCallback(
    (payload: PickPayload) => {
      if (!pickerPos) return;
      const pos = screenToFlowPosition({ x: pickerPos.x, y: pickerPos.y });
      const pending = pendingConn.current;
      pendingConn.current = null;

      if (pending) {
        // 从端口拖到空白：新建节点后自动连边（ComfyUI 风格）
        const newNodeId = addNode(payload.id, { x: pos.x - 112, y: pos.y - 20 });
        if (newNodeId) {
          const defs = useRegistryStore.getState().defs;
          const sgs = useWorkflowStore.getState().subgraphs;
          const newNode = useWorkflowStore.getState().nodes.find((n) => n.id === newNodeId);
          const newDef = newNode ? resolvePorts(newNode.data.typeId, newNode.data.params, defs, sgs) : null;
          const srcNode = useWorkflowStore.getState().nodes.find((n) => n.id === pending.fromNodeId);
          const srcDef = srcNode ? resolvePorts(srcNode.data.typeId, srcNode.data.params, defs, sgs) : null;
          if (newDef) {
            const fromIsSource = pending.fromType === 'source';
            const srcPort = fromIsSource
              ? srcDef?.outputs.find((o) => o.id === pending.fromHandleId)
              : srcDef?.inputs.find((i) => i.id === pending.fromHandleId);
            let targetHandle: string | undefined;
            if (fromIsSource) {
              // 新节点作为 target：找第一个与源输出类型兼容的输入端口
              targetHandle = newDef.inputs.find(
                (i) => srcPort && arePortsCompatible(srcPort.type, i.type),
              )?.id ?? newDef.inputs[0]?.id;
            } else {
              // 新节点作为 source：找第一个与源输入类型兼容的输出端口
              targetHandle = newDef.outputs.find(
                (o) => srcPort && arePortsCompatible(o.type, srcPort.type),
              )?.id ?? newDef.outputs[0]?.id;
            }
            if (targetHandle) {
              const connection: Connection = fromIsSource
                ? { source: pending.fromNodeId, sourceHandle: pending.fromHandleId, target: newNodeId, targetHandle }
                : { source: newNodeId, sourceHandle: targetHandle, target: pending.fromNodeId, targetHandle: pending.fromHandleId };
              useWorkflowStore.getState().onConnect(connection);
            }
          }
        }
        setPickerPos(null);
        return;
      }

      if (payload.kind === 'subgraph') {
        if (!isSplit) addSubgraphRef(payload.id, { x: pos.x - 112, y: pos.y - 20 });
      } else {
        addNode(payload.id, { x: pos.x - 112, y: pos.y - 20 });
      }
      setPickerPos(null);
    },
    [pickerPos, screenToFlowPosition, addSubgraphRef, addNode, isSplit],
  );

  // 从端口拖拽到空白处松手：缓存源端口上下文，弹出命令面板建节点并自动连边（ComfyUI 风格）
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, connState: FinalConnectionState) => {
      // 已连到有效目标：onConnect 已建边，无需处理
      if (connState.toHandle) return;
      const from = connState.fromHandle;
      if (!from) return;
      const ev = _event as MouseEvent;
      const screen = 'changedTouches' in _event
        ? { x: (_event as TouchEvent).changedTouches[0].clientX, y: (_event as TouchEvent).changedTouches[0].clientY }
        : { x: ev.clientX, y: ev.clientY };
      pendingConn.current = {
        fromNodeId: from.nodeId,
        fromHandleId: from.id ?? '',
        fromType: (from.type ?? 'source') as 'source' | 'target',
        screen,
      };
      setPickerPos(screen);
    },
    [],
  );

  // 鼠标模式：click=仅点击选中（左键不平移画布、不框选）；move=拖动；select=框选
  const selectionOnDrag = interactionMode === 'select';
  const panOnDrag: number[] = interactionMode === 'move' ? [0, 1] : [1];

  return (
    <div
      className="sm-canvas-dot relative h-full w-full"
      onDrop={onDrop}
      onDragOverCapture={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onMouseDownCapture={onPaneMouseDownCapture}
      onDoubleClick={onCanvasDoubleClick}
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
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
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
        onPaneClick={() => setSelected(null, wfId)}
        zoomOnDoubleClick={false}
        onNodeContextMenu={(e, node) => {
          if (isSplit) return;
          // 右键拖动框选（已移动）不弹菜单，仅清除标记
          if (rightStart.current?.moved) {
            e.preventDefault();
            rightStart.current = null;
            return;
          }
          e.preventDefault();
          rightStart.current = null;
          setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
        }}
        onPaneContextMenu={(e) => {
          if (isSplit) return;
          if (rightStart.current?.moved) {
            e.preventDefault();
            rightStart.current = null;
            return;
          }
          e.preventDefault();
          rightStart.current = null;
          const ev = e as React.MouseEvent;
          setMenu({ x: ev.clientX, y: ev.clientY });
        }}
        onSelectionContextMenu={(e) => {
          if (isSplit) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="var(--sm-canvas-grid)"
          />
        )}
        {/* 左上：对齐 / 分布工具条（ComfyUI 风格，对选中≥2节点生效） */}
        <Panel position="top-left" className="sm-cv-panel">
          <div className="sm-cv-modes sm-cv-modes-h" title="对齐与分布（先框选多个节点）">
            <button className="sm-cv-btn" title="左对齐" onClick={() => alignSelected('left')}><AlignStartVertical size={15} /></button>
            <button className="sm-cv-btn" title="水平居中" onClick={() => alignSelected('hcenter')}><AlignCenterVertical size={15} /></button>
            <button className="sm-cv-btn" title="右对齐" onClick={() => alignSelected('right')}><AlignEndVertical size={15} /></button>
            <span className="sm-cv-sep" />
            <button className="sm-cv-btn" title="顶对齐" onClick={() => alignSelected('top')}><AlignStartHorizontal size={15} /></button>
            <button className="sm-cv-btn" title="垂直居中" onClick={() => alignSelected('vcenter')}><AlignCenterHorizontal size={15} /></button>
            <button className="sm-cv-btn" title="底对齐" onClick={() => alignSelected('bottom')}><AlignEndHorizontal size={15} /></button>
            <span className="sm-cv-sep" />
            <button className="sm-cv-btn" title="水平等距分布" onClick={() => distributeSelected('x')}><AlignHorizontalSpaceBetween size={15} /></button>
            <button className="sm-cv-btn" title="垂直等距分布" onClick={() => distributeSelected('y')}><AlignVerticalSpaceBetween size={15} /></button>
          </div>
        </Panel>

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
              className={`sm-cv-btn ${interactionMode === 'click' ? 'active' : ''}`}
              title="点击模式（左键点击选中节点，不平移也不框选）"
              onClick={() => setInteractionMode('click')}
            >
              <MousePointer2 size={15} />
            </button>
            <button
              className={`sm-cv-btn ${showMinimap ? 'active' : ''}`}
              title={showMinimap ? '隐藏小地图' : '显示小地图'}
              onClick={toggleMinimap}
            >
              <MapIcon size={15} />
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
      )}

      {/* 节点组框（纯视觉 overlay，置于 React Flow 之上，仅标题条可交互） */}
      {!noWorkflows && !isSplit && <GroupLayer />}

      {/* 右键菜单：子图打包 / 展开、节点编组 */}
      {menu && !noWorkflows && !isSplit && (
        <div
          className="fixed z-50 min-w-[176px] overflow-hidden rounded-lg border border-line bg-paper py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menuRefNode ? (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft"
              onClick={() => {
                closeMenu();
                unpackSubgraph(menuRefNode.id);
              }}
            >
              <Ungroup size={13} /> 展开子图
            </button>
          ) : (
            <>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
                onClick={handlePack}
                title="把选中的节点打包成可复用的子图"
                disabled={targetIds.length === 0}
              >
                <Boxes size={13} /> 打包为子图
                <span className="ml-auto text-[10.5px] text-ink-faint">{targetIds.length} 个</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
                onClick={handleGroup}
                disabled={targetIds.length === 0}
                title="把选中的节点框成一组，可整体移动、折叠（不影响运行）"
              >
                <Group size={13} /> 编为一组
                <span className="ml-auto text-[10.5px] text-ink-faint">{targetIds.length} 个</span>
              </button>
            </>
          )}
          {targetIds.length === 0 && !menuRefNode && (
            <p className="px-3 py-1 text-[11px] leading-relaxed text-ink-faint">
              先用框选模式选中若干节点
            </p>
          )}
        </div>
      )}

      {noWorkflows && !isSplit && welcomeDismissed && (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <Sparkles size={22} style={{ color: 'var(--sm-ink-faint)' }} />
            <p className="text-[13px]" style={{ color: 'var(--sm-ink-faint)' }}>
              没有打开的工作流
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => (onNewProject ? onNewProject() : newWorkflow())}
                className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition"
                style={{ background: 'var(--sm-accent)' }}
              >
                新建项目
              </button>
              <button
                onClick={() => setWelcomeDismissed(false)}
                className="rounded-lg border px-3 py-1.5 text-[12.5px] transition hover:bg-[var(--sm-bg-soft)]"
                style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
              >
                查看引导
              </button>
            </div>
          </div>
        </div>
      )}

      {noWorkflows && !isSplit && !welcomeDismissed && (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div
            className="relative grid w-[720px] max-w-full grid-cols-1 gap-6 rounded-2xl border p-7 shadow-2xl md:grid-cols-[260px_1fr]"
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
                  onClick={() => (onNewProject ? onNewProject() : newWorkflow())}
                  className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
                  style={{ color: 'var(--sm-ink)' }}
                >
                  <FolderPlus size={16} style={{ color: 'var(--sm-accent)' }} />
                  新建项目
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

      {packPrompt && (
        <NamePrompt
          title="给这个子图起个名字"
          initial={`子图 ${Object.keys(subgraphs).length + 1}`}
          onConfirm={(name) => {
            packAsSubgraph(targetIds, name);
            setPackPrompt(false);
          }}
          onCancel={() => setPackPrompt(false)}
        />
      )}

      {/* 双击折叠组进入的子图编辑视图（Q5=D） */}
      {!isSplit && focusedSubgraphId && <SubgraphEditor subgraphId={focusedSubgraphId} />}

      {/* 仿 ComfyUI：双击空白画布弹出节点选择窗口 */}
      {pickerPos && (
        <NodePickerModal screenPos={pickerPos} onSelect={onPickNode} onClose={() => setPickerPos(null)} />
      )}

      {/* 运行期调度看板（Job Board）：浮于画布右上角 */}
      <JobBoard />
      {/* Companion 浮窗：常驻状态球，展示运行态与 token 消耗（经 portal 渲染到 body） */}
      <Companion />
    </div>
  );
}
