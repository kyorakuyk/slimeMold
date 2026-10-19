import { useMemo } from 'react';
import { resolvePorts } from '../engine/subgraph';
import type { FlowEdge, FlowNode, PortDef } from '../types/graph';
import type { NodeGroup } from '../types/workflow';
import { projectStyledEdges } from './workflowEdgeProjection';

type ResolvePortDefs = Parameters<typeof resolvePorts>[2];
type ResolveSubgraphs = Parameters<typeof resolvePorts>[3];

type CanvasGraphProjectionInput = {
  isSplit: boolean;
  activeNodes: FlowNode[];
  activeEdges: FlowEdge[];
  splitNodes: FlowNode[];
  splitEdges: FlowEdge[];
  groups: NodeGroup[];
  allDefs: ResolvePortDefs;
  subgraphs: ResolveSubgraphs;
};

export default function useCanvasGraphProjection({
  isSplit,
  activeNodes,
  activeEdges,
  splitNodes,
  splitEdges,
  groups,
  allDefs,
  subgraphs,
}: CanvasGraphProjectionInput) {
  // grpnode_* 是折叠组的派生代理节点，只由本组件生成，不应出现在 store.nodes 里。
  // 兜底过滤一层，防止历史数据（早期版本误写入）把组当成普通节点。
  // 注意：用 useMemo 缓存，避免每帧都新建 filter 数组（拖拽时 activeNodes 引用变，
  // 但 grpnode 成员极少变化，缓存可保持 rawNodes 引用稳定，减少下游重算）。
  const rawNodes = useMemo(
    () => (isSplit ? splitNodes : activeNodes.filter((node) => !node.id.startsWith('grpnode_'))),
    [isSplit, splitNodes, activeNodes],
  );
  const edges = isSplit ? splitEdges : activeEdges;

  // 折叠的节点组：其成员节点在画布上隐藏（仅保留组代理节点）
  const hiddenByGroup = useMemo(() => {
    if (isSplit) return new Set<string>();
    const hidden = new Set<string>();
    for (const group of groups) if (group.collapsed) for (const id of group.nodeIds) hidden.add(id);
    return hidden;
  }, [groups, isSplit]);

  // 折叠分组 -> 代理节点：左右按类型聚合生成虚拟端口，作为 React Flow 节点
  const groupProxyNodes = useMemo<FlowNode[]>(() => {
    if (isSplit) return [];
    const output: FlowNode[] = [];
    for (const group of groups) {
      if (!group.collapsed) continue;
      // 折叠态位置：优先用记录的包围盒，否则按成员位置估算
      let x = group.bounds?.x ?? 0;
      let y = group.bounds?.y ?? 0;
      let width = group.bounds?.width ?? 200;
      if (group.bounds == null && group.nodeIds.length) {
        const members = rawNodes.filter((node) => group.nodeIds.includes(node.id));
        if (members.length) {
          x = Math.min(...members.map((node) => node.position.x));
          y = Math.min(...members.map((node) => node.position.y));
          width = 200;
        }
      }
      output.push({
        id: `grpnode_${group.id}`,
        type: 'groupProxy',
        position: { x, y },
        data: { group, box: { x, y, width, height: 60 } },
        selected: group.nodeIds.some((id) => rawNodes.find((node) => node.id === id)?.selected),
      } as unknown as FlowNode);
    }
    return output;
  }, [groups, rawNodes, isSplit]);

  // 折叠组：成员 -> 代理端口 handle 映射（用于重定向外部连线）
  const memberToProxy = useMemo(() => {
    const mapping = new Map<string, { nodeId: string; handle: string; type: string }>();
    for (const group of groups) {
      if (!group.collapsed || !group.proxyPorts) continue;
      for (const port of group.proxyPorts) {
        const nodeId = `grpnode_${group.id}`;
        for (const target of port.internalTargets) {
          mapping.set(target.nodeId, { nodeId, handle: port.id, type: port.kind });
        }
      }
    }
    return mapping;
  }, [groups]);

  const nodes = useMemo(() => {
    const base =
      hiddenByGroup.size === 0
        ? rawNodes
        : rawNodes.map((node) => (hiddenByGroup.has(node.id) ? { ...node, hidden: true } : node));
    return [...base, ...groupProxyNodes];
  }, [rawNodes, hiddenByGroup, groupProxyNodes]);

  // 数据流向可视化：连线颜色跟随「源端口类型」（ComfyUI 风格）
  // 端口解析信号：仅当节点的「类型 + 参数」变化时才变。
  // 拖拽只改 position，此 key 不变 -> outsByNode/styledEdges 在拖拽时不重算，
  // 否则每帧全量 resolvePorts + 生成全新 edges 数组会让 React Flow 反复重测，多次拖拽后卡死。
  const portSig = useMemo(
    () =>
      nodes
        .map((node) => node.id + ':' + node.data.typeId + ':' + (node.data.params ? JSON.stringify(node.data.params) : ''))
        .join('|'),
    [nodes],
  );
  const outsByNode = useMemo(() => {
    const map: Record<string, PortDef[]> = {};
    for (const node of nodes) {
      map[node.id] = resolvePorts(node.data.typeId, node.data.params, allDefs, subgraphs).outputs;
    }
    return map;
  }, [portSig, nodes, allDefs, subgraphs]);
  const styledEdges = useMemo(
    () => projectStyledEdges(edges, outsByNode, memberToProxy),
    [edges, outsByNode, memberToProxy],
  );

  return { nodes, edges, styledEdges };
}
