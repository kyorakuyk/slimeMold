// 节点 / 分组创建期的纯辅助计算。
// 这些函数只依赖 registry store 单例（节点定义注册中心），不依赖 workflow store，
// 因而可独立测试、避免 workflowStore 进一步膨胀为上帝模块。
// `recomputeProxyPorts` receives node definitions through its caller; `defaultParams` remains a thin registry adapter.
// Tests for the pure port projection pass an explicit definition table.

import type { NodeDefinition } from '../types/node';
import type { NodeGroup, ProxyPort, SubgraphDef, VirtualEdge } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types';
import type { PortType } from '../types/graph';
import { getNodeDef } from './registryStore';

/** 组框预设配色（创建时轮换取用） */
export const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

/**
 * 根据分组内部节点，按「端口类型」聚合推导折叠态的代理端口（ProxyPort）
 * 与一对多虚拟边（VirtualEdge）。
 * - 内部共需 2×img + 1×txt 输入 -> 仅生成 img、txt 两个聚合输入端口。
 * - 外部多对一：多个父图连线可连到同一个聚合端口。
 * - 内部一对多：聚合端口 -> 所有同类型内部端口（virtualEdges.targets）。
 */
export function recomputeProxyPorts(
  group: NodeGroup,
  _sg: SubgraphDef,
  nodes: FlowNode[],
  _edges: FlowEdge[],
  defs: Record<string, NodeDefinition>,
): NodeGroup {
  const memberSet = new Set(group.nodeIds);

  // 聚合：type -> 内部端口列表
  const inByType = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const outByType = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const n of nodes) {
    if (!memberSet.has(n.id)) continue;
    const def = defs[n.data.typeId];
    if (!def) continue;
    for (const p of def.inputs ?? []) {
      const list = inByType.get(p.type ?? 'any') ?? [];
      list.push({ nodeId: n.id, portId: p.id });
      inByType.set(p.type ?? 'any', list);
    }
    for (const p of def.outputs ?? []) {
      const list = outByType.get(p.type ?? 'any') ?? [];
      list.push({ nodeId: n.id, portId: p.id });
      outByType.set(p.type ?? 'any', list);
    }
  }

  const proxyPorts: ProxyPort[] = [];
  const virtualEdges: VirtualEdge[] = [];
  let idx = 0;
  for (const [type, targets] of inByType) {
    const id = `${group.id}:in:${type}`;
    proxyPorts.push({ id, kind: 'input', type: type as PortType, label: type, internalTargets: targets });
    virtualEdges.push({ id: `ve_${idx++}`, proxyPortId: id, kind: 'input', targets });
  }
  for (const [type, targets] of outByType) {
    const id = `${group.id}:out:${type}`;
    proxyPorts.push({ id, kind: 'output', type: type as PortType, label: type, internalTargets: targets });
    virtualEdges.push({ id: `ve_${idx++}`, proxyPortId: id, kind: 'output', targets });
  }
  return { ...group, proxyPorts, virtualEdges };
}

/** 给定节点 typeId，返回其定义中声明的默认参数（仅取有 default 的键） */
export function defaultParams(typeId: string): Record<string, unknown> {
  const def = getNodeDef(typeId);
  const params: Record<string, unknown> = {};
  for (const p of def?.params ?? []) {
    if (p.default !== undefined) params[p.key] = p.default;
  }
  return params;
}
