/**
 * 子图编辑视图（双击折叠组进入，Q5=D）。
 * - 渲染子图内部节点/连线，可拖拽与连线。
 * - 左侧列出按类型聚合的输入代理端口，右侧列出输出代理端口（Q12=A）。
 * - 编辑结果写回 subgraph 定义（saveSubgraphDef 重新推断端口）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import { X } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useRegistryStore } from '../store/registryStore';
import BaseNode from './nodes/BaseNode';
import ProxyPortNode from './nodes/ProxyPortNode';
import { NodePickerModal, type PickPayload } from '../components/NodePickerModal';
import type { NodeTypes } from '@xyflow/react';
import type { FlowNode, FlowEdge, NodeStatus, SubgraphDef, SubgraphPort, PortType, WorkflowNodeData } from '../types';
import { resolvePorts } from '../engine/subgraph';

const nodeTypes = { base: BaseNode, proxyIn: ProxyPortNode, proxyOut: ProxyPortNode } as unknown as NodeTypes;

export default function SubgraphEditor({ subgraphId }: { subgraphId: string }) {
  const sg = useWorkflowStore((s) => s.subgraphs[subgraphId]);
  const saveSubgraphDef = useWorkflowStore((s) => s.saveSubgraphDef);
  const syncGroupProxies = useWorkflowStore((s) => s.syncGroupProxies);
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);
  const defs = useRegistryStore((s) => s.defs);
  const subgraphs = useWorkflowStore((s) => s.subgraphs);

  const [innerNodes, setInnerNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  // 代理端点节点的固定 id（写回时排除），它们不存进 innerNodes，而是实时派生
  const PROXY_IN_ID = '__proxy_in__';
  const PROXY_OUT_ID = '__proxy_out__';

  // 聚合代理端口（按类型），基于「子图定义 sg」，用于 close() 写回时做标签匹配。
  const { inPorts, outPorts } = useMemo(() => {
    const def = sg;
    if (!def) return { inPorts: [] as { type: PortType; label: string }[], outPorts: [] as { type: PortType; label: string }[] };
    const agg = (arr: { type?: PortType; label: string }[]) => {
      const m = new Map<string, { type: PortType; label: string }>();
      for (const p of arr) if (!m.has(p.type ?? 'any')) m.set(p.type ?? 'any', { type: p.type ?? 'any', label: p.label });
      return [...m.values()];
    };
    return { inPorts: agg(def.inputs), outPorts: agg(def.outputs) };
  }, [sg]);

  // 实时聚合代理端口：根据当前内部节点动态推导，
  // 双击加入新节点后其输入/输出端口立即反映到左右代理节点上。
  const liveInPorts = useMemo(() => {
    const m = new Map<string, { type: PortType; label: string }>();
    for (const n of innerNodes) {
      const rp = resolvePorts(n.data?.typeId, n.data?.params ?? {}, defs, subgraphs);
      for (const p of rp.inputs) if (!m.has(p.type ?? 'any')) m.set(p.type ?? 'any', { type: p.type ?? 'any', label: p.label });
    }
    return [...m.values()];
  }, [innerNodes, defs]);

  const liveOutPorts = useMemo(() => {
    const m = new Map<string, { type: PortType; label: string }>();
    for (const n of innerNodes) {
      const rp = resolvePorts(n.data?.typeId, n.data?.params ?? {}, defs, subgraphs);
      for (const p of rp.outputs) if (!m.has(p.type ?? 'any')) m.set(p.type ?? 'any', { type: p.type ?? 'any', label: p.label });
    }
    return [...m.values()];
  }, [innerNodes, defs]);

  // 左右代理节点：实时从 live 端口派生，保证 data.ports 始终有效
  const proxyNodes: FlowNode[] = [
    {
      id: PROXY_IN_ID,
      type: 'proxyIn',
      position: { x: 40, y: 160 },
      draggable: false,
      data: {
        side: 'in' as const,
        ports: liveInPorts.map((p) => ({ id: `in:${p.type}`, type: p.type, label: p.label })),
      } as unknown as WorkflowNodeData,
    },
    {
      id: PROXY_OUT_ID,
      type: 'proxyOut',
      position: { x: 720, y: 160 },
      draggable: false,
      data: {
        side: 'out' as const,
        ports: liveOutPorts.map((p) => ({ id: `out:${p.type}`, type: p.type, label: p.label })),
      } as unknown as WorkflowNodeData,
    },
  ];

  // 传给 ReactFlow 的完整节点列表（内部节点 + 实时代理节点）
  const nodes = useMemo(() => [...innerNodes, ...proxyNodes], [innerNodes, proxyNodes]);

  // 初始化：载入子图内部节点（代理节点由上面的派生逻辑注入）
  useEffect(() => {
    if (!sg) return;
    const baseNodes: FlowNode[] = sg.nodes.map((n) => ({
      id: n.id,
      type: 'base',
      position: n.position,
      data: { typeId: n.typeId, label: n.label, params: n.params ?? {}, status: 'idle' as NodeStatus, dirty: true },
    }));
    setInnerNodes(baseNodes);
    setEdges(
      sg.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? undefined,
        target: e.target,
        targetHandle: e.targetHandle ?? undefined,
      })),
    );
  }, [sg]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) =>
    setInnerNodes((ns) =>
      applyNodeChanges(
        changes.filter((c) => c.type === 'add' || (c.id !== PROXY_IN_ID && c.id !== PROXY_OUT_ID)),
        ns,
      ),
    );
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es));
  const onConnect = (c: Connection) => setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.target}-${Date.now()}` }, es));

  // 在子图内部添加一个节点（双击空白弹窗后调用），仅写入本地 innerNodes，退出时由 close 写回 def
  const addNodeInSubgraph = (payload: PickPayload, flow: { x: number; y: number }) => {
    if (payload.kind === 'subgraph') return; // 子图内暂不允许再嵌套子图引用
    const def = defs[payload.id];
    if (!def) return;
    const node: FlowNode = {
      id: crypto.randomUUID(),
      type: 'base',
      position: { x: flow.x - 112, y: flow.y - 20 },
      data: {
        typeId: payload.id,
        label: def.name,
        params: Object.fromEntries((def.params ?? []).map((p) => [p.key, p.default])),
        status: 'idle' as NodeStatus,
      },
    };
    setInnerNodes((ns) => [...ns, node]);
  };

  const close = () => {
    // 写回子图定义：排除虚拟代理端点节点；涉及代理节点的连线转为子图对外端口语义
    const innerNodesArr = innerNodes;
    const innerNodesForWrite = innerNodesArr.map((n) => ({
      id: n.id,
      typeId: n.data.typeId,
      label: n.data.label,
      position: n.position,
      params: n.data.params ?? {},
    }));
    const nodeMap = new Map(innerNodesForWrite.map((n) => [n.id, n]));
    const isNode = (id: string) => id !== PROXY_IN_ID && id !== PROXY_OUT_ID;

    const portInfo = (nodeId: string, handleId: string | null) => {
      const nd = nodeMap.get(nodeId);
      if (!nd) return { type: 'any' as PortType, label: handleId ?? 'port' };
      const rp = resolvePorts(nd.typeId, nd.params, defs, subgraphs);
      const port = [...rp.inputs, ...rp.outputs].find((p) => p.id === handleId);
      return { type: (port?.type ?? 'any') as PortType, label: port?.label ?? handleId ?? 'port' };
    };

    // 代理端口的 Handle id 形如 `${portId}__in`(target) / `${portId}__out`(source)
    const proxyHandleKey = (handleId: string | null | undefined) =>
      handleId ? handleId.replace(/__(in|out)$/, '') : null;

    const manualInputs: SubgraphPort[] = [];
    const manualOutputs: SubgraphPort[] = [];
    for (const e of edges) {
      const srcProxy = e.source === PROXY_IN_ID || e.source === PROXY_OUT_ID;
      const tgtProxy = e.target === PROXY_IN_ID || e.target === PROXY_OUT_ID;
      if (!srcProxy && !tgtProxy) continue;

      if (e.target === PROXY_IN_ID && isNode(e.source)) {
        // 节点输出 -> 输入代理：该节点端口提升为子图输入端口
        const info = portInfo(e.source, e.sourceHandle ?? null);
        manualInputs.push({
          id: `in_${e.source}_${e.sourceHandle ?? 'h'}`,
          label: info.label,
          type: info.type,
          innerNodeId: e.source,
          innerHandle: e.sourceHandle ?? null,
        });
      } else if (e.source === PROXY_IN_ID && isNode(e.target)) {
        // 输入代理 -> 节点输入：子图输入端口驱动该节点输入
        const key = proxyHandleKey(e.sourceHandle);
        manualInputs.push({
          id: `in_${key ?? 'p'}`,
          label: key ? (inPorts.find((p) => `in:${p.type}` === key)?.label ?? key) : (e.sourceHandle ?? 'in'),
          type: key ? (inPorts.find((p) => `in:${p.type}` === key)?.type ?? 'any') : 'any',
          innerNodeId: e.target,
          innerHandle: e.targetHandle ?? null,
        });
      } else if (e.source === PROXY_OUT_ID && isNode(e.target)) {
        // 输出代理 -> 节点输入：该节点端口提升为子图输出端口
        const info = portInfo(e.target, e.targetHandle ?? null);
        manualOutputs.push({
          id: `out_${e.target}_${e.targetHandle ?? 'h'}`,
          label: info.label,
          type: info.type,
          innerNodeId: e.target,
          innerHandle: e.targetHandle ?? null,
        });
      } else if (e.target === PROXY_OUT_ID && isNode(e.source)) {
        // 节点输出 -> 输出代理：子图输出端口来自该节点输出
        const key = proxyHandleKey(e.targetHandle);
        manualOutputs.push({
          id: `out_${key ?? 'p'}`,
          label: key ? (outPorts.find((p) => `out:${p.type}` === key)?.label ?? key) : (e.targetHandle ?? 'out'),
          type: key ? (outPorts.find((p) => `out:${p.type}` === key)?.type ?? 'any') : 'any',
          innerNodeId: e.source,
          innerHandle: e.sourceHandle ?? null,
        });
      }
    }

    const innerEdges = edges
      .filter((e) => isNode(e.source) && isNode(e.target))
      .map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? null, target: e.target, targetHandle: e.targetHandle ?? null }));

    const next: SubgraphDef = {
      ...sg!,
      nodes: innerNodesForWrite,
      edges: innerEdges,
      // 保留自动推断的端口，并并入手动连线得到的端口
      inputs: [...sg!.inputs.filter((p) => !manualInputs.some((m) => m.innerNodeId === p.innerNodeId && m.innerHandle === p.innerHandle)), ...manualInputs],
      outputs: [...sg!.outputs.filter((p) => !manualOutputs.some((m) => m.innerNodeId === p.innerNodeId && m.innerHandle === p.innerHandle)), ...manualOutputs],
    };
    saveSubgraphDef(next);
    // 重算所有引用该子图的分组的代理端口/虚拟边，使父图实时同步（节点增删后端口变化）
    syncGroupProxies(subgraphId);
    setFocusedSubgraph(null);
  };

  if (!sg) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[rgba(18,18,20,0.96)]">
      {/* 面包屑 / 标题栏 */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-[13px] text-ink">
        <span className="text-ink-faint">父图</span>
        <span className="text-ink-faint">/</span>
        <span className="font-semibold">子图：{sg.name}</span>
        <span className="ml-2 rounded bg-paper-soft px-2 py-0.5 text-[11px] text-ink-soft">
          左侧=输入代理端口，右侧=输出代理端口
        </span>
        <button
          className="ml-auto flex items-center gap-1 rounded-md border border-line px-3 py-1 text-[12.5px] text-ink transition-colors hover:bg-paper-soft"
          onClick={close}
        >
          <X size={14} /> 完成并返回
        </button>
      </div>

      <div className="relative flex-1">
        <ReactFlowProvider>
          <InnerFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            addNode={addNodeInSubgraph}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/** 放在 ReactFlowProvider 内部的画布：可双击空白添加节点 */
function InnerFlow({
  nodes,
  edges,
  nodeTypes,
  onNodesChange,
  onEdgesChange,
  onConnect,
  addNode,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  nodeTypes: Record<string, unknown>;
  onNodesChange: (c: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (c: EdgeChange<FlowEdge>[]) => void;
  onConnect: (c: Connection) => void;
  addNode: (payload: PickPayload, flow: { x: number; y: number }) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  const onDoubleClick = (e: React.MouseEvent) => {
    // 仅当双击的是画布空白处（pane）时弹窗，避免双击节点也触发
    const t = e.target as HTMLElement;
    if (!t.classList.contains('react-flow__pane')) return;
    setPicker({ x: e.clientX, y: e.clientY });
  };

  const onPick = (payload: PickPayload) => {
    if (picker) {
      const flow = screenToFlowPosition({ x: picker.x, y: picker.y });
      addNode(payload, flow);
    }
    setPicker(null);
  };

  return (
    <div className="relative h-full w-full" onDoubleClick={onDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes as NodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={['Backspace', 'Delete', 'Enter']}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.08)" />
      </ReactFlow>
      {picker && (
        <NodePickerModal screenPos={picker} onSelect={onPick} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
