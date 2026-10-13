import type { Connection, Edge } from '@xyflow/react';
import { resolvePorts } from '../engine/subgraph';
import { arePortsCompatible, type FlowEdge, type FlowNode } from '../types/graph';
import { wouldCreateCycle } from '../engine/topoSort';

type ResolvePortDefs = Parameters<typeof resolvePorts>[2];
type ResolveSubgraphs = Parameters<typeof resolvePorts>[3];

interface CanConnectEdgesInput {
  conn: Connection | Edge;
  edges: FlowEdge[];
  nodes: FlowNode[];
  allDefs: ResolvePortDefs;
  subgraphs: ResolveSubgraphs;
}

/**
 * 连线时的友好预校验：环路或端口类型不兼容时，手柄直接显示不可连接。
 * 端口须按节点实例解析：子图节点的端口来自其引用的子图定义。
 */
export function canConnectEdges({ conn, edges, nodes, allDefs, subgraphs }: CanConnectEdgesInput): boolean {
  if (!conn.source || !conn.target) return false;
  if (conn.source === conn.target) return false;
  if (wouldCreateCycle(conn.source, conn.target, edges)) return false;
  const srcNode = nodes.find((n) => n.id === conn.source);
  const tgtNode = nodes.find((n) => n.id === conn.target);
  const srcDef = resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, allDefs, subgraphs);
  const tgtDef = resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, allDefs, subgraphs);
  const srcPort = srcDef.outputs.find((o) => o.id === conn.sourceHandle);
  const tgtPort = tgtDef.inputs.find((i) => i.id === conn.targetHandle);
  return arePortsCompatible(srcPort?.type, tgtPort?.type);
}
