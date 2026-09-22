/**
 * 子图（Subgraph）核心逻辑。
 *
 * 设计：方案 A「子图引用节点 + 执行期扁平化」
 *  - 子图定义（SubgraphDef）存在项目级 subgraphs 字典里，内容是一份普通的 nodes/edges 快照。
 *  - 画布上用一个 `subgraph.ref` 节点引用它，params.subgraphId 指向定义。
 *  - 真正运行前，executor 调用 flattenSubgraphs() 把所有 ref 节点就地展开成内部节点，
 *    因此执行引擎、缓存、分支剪枝、增量运行全都无需改动——它看到的永远是一张扁平图。
 *
 * 接口推断：子图内部「没有被内部连线占用」的端口自动提升为对外端口。
 *  - 输入：某节点的 input handle 在子图内部没有入边 -> 提升为子图输入
 *  - 输出：某节点的 output handle 在子图内部没有出边 -> 提升为子图输出
 */
import type { NodeDefinition } from '../types/node';
import type { SubgraphDef, SubgraphPort, WorkflowFileEdge, WorkflowFileNode } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types/graph';
import type { PortDef } from '../types/graph';

/** 子图引用节点的类型 id */
export const SUBGRAPH_REF_TYPE = 'subgraph.ref';

/** 展开时生成的内部节点 id 前缀分隔符（用于回溯定位原始 ref 节点） */
const SEP = '::';

/** 生成展开后的内部节点 id：<refNodeId>::<innerNodeId> */
export function expandedId(refNodeId: string, innerNodeId: string): string {
  return `${refNodeId}${SEP}${innerNodeId}`;
}

/** 从展开后的节点 id 反查它属于哪个 ref 节点；非展开节点返回 null */
export function ownerRefId(expanded: string): string | null {
  const i = expanded.indexOf(SEP);
  return i === -1 ? null : expanded.slice(0, i);
}

/**
 * 根据一组节点+连线，推断子图的对外输入/输出端口。
 * @param nodes 子图内部节点
 * @param edges 子图内部连线
 * @param defs  节点定义表（用于取每个节点声明了哪些端口）
 */
export function inferPorts(
  nodes: WorkflowFileNode[],
  edges: WorkflowFileEdge[],
  defs: Record<string, NodeDefinition>,
): { inputs: SubgraphPort[]; outputs: SubgraphPort[] } {
  const usedIn = new Set(edges.map((e) => `${e.target}|${e.targetHandle ?? ''}`));
  const usedOut = new Set(edges.map((e) => `${e.source}|${e.sourceHandle ?? ''}`));

  const inputs: SubgraphPort[] = [];
  const outputs: SubgraphPort[] = [];

  for (const n of nodes) {
    const def = defs[n.typeId];
    if (!def) continue;
    for (const p of def.inputs ?? []) {
      if (usedIn.has(`${n.id}|${p.id}`)) continue;
      inputs.push({
        id: `in_${n.id}_${p.id}`,
        label: `${n.label}·${p.label}`,
        type: p.type,
        innerNodeId: n.id,
        innerHandle: p.id,
      });
    }
    for (const p of def.outputs ?? []) {
      if (usedOut.has(`${n.id}|${p.id}`)) continue;
      outputs.push({
        id: `out_${n.id}_${p.id}`,
        label: `${n.label}·${p.label}`,
        type: p.type,
        innerNodeId: n.id,
        innerHandle: p.id,
      });
    }
  }
  return { inputs, outputs };
}

/**
 * 把画布上选中的一批节点打包成子图定义。
 * 只保留「两端都在选区内」的连线；跨越边界的连线由 inferPorts 转成对外端口。
 */
export function packSubgraph(
  name: string,
  selectedNodes: FlowNode[],
  allEdges: FlowEdge[],
  defs: Record<string, NodeDefinition>,
): SubgraphDef {
  const idSet = new Set(selectedNodes.map((n) => n.id));
  const nodes: WorkflowFileNode[] = selectedNodes.map((n) => ({
    id: n.id,
    typeId: n.data.typeId,
    label: n.data.label,
    position: { ...n.position },
    params: { ...n.data.params },
  }));
  const edges: WorkflowFileEdge[] = allEdges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
    }));

  const { inputs, outputs } = inferPorts(nodes, edges, defs);
  const now = new Date().toISOString();
  return {
    id: `sg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    category: '子图',
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
    inputs,
    outputs,
  };
}

/**
 * 解析某个节点实际对外暴露的端口。
 * 普通节点直接取自 NodeDefinition；subgraph.ref 节点的端口是动态的，
 * 取自它所引用的子图定义（inputs/outputs 提升而来）。
 */
export function resolvePorts(
  typeId: string,
  params: Record<string, unknown> | undefined,
  defs: Record<string, NodeDefinition>,
  subgraphs: Record<string, SubgraphDef>,
): { inputs: PortDef[]; outputs: PortDef[]; name: string } {
  if (typeId === SUBGRAPH_REF_TYPE) {
    const sg = subgraphs[String(params?.subgraphId ?? '')];
    if (!sg) return { inputs: [], outputs: [], name: '子图（定义丢失）' };
    return {
      inputs: sg.inputs.map((p) => ({ id: p.id, label: p.label, type: p.type })),
      outputs: sg.outputs.map((p) => ({ id: p.id, label: p.label, type: p.type })),
      name: sg.name,
    };
  }
  const def = defs[typeId];
  return {
    inputs: def?.inputs ?? [],
    outputs: def?.outputs ?? [],
    name: def?.name ?? typeId,
  };
}

/**
 * 执行期扁平化：把图中所有 subgraph.ref 节点替换为其内部节点副本。
 *
 * 处理三类连线：
 *  1. 内部连线      -> 直接复制，两端 id 加前缀
 *  2. 外部 -> ref   -> 目标重定向到 该输入端口对应的 内部节点/handle
 *  3. ref -> 外部   -> 源重定向到 该输出端口对应的 内部节点/handle
 *
 * 支持子图嵌套引用（子图内部又放了 subgraph.ref），通过递归展开实现；
 * 用 stack 检测循环引用，遇到则抛错。
 */
export function flattenSubgraphs(
  nodes: FlowNode[],
  edges: FlowEdge[],
  subgraphs: Record<string, SubgraphDef>,
  stack: string[] = [],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const refNodes = nodes.filter((n) => n.data.typeId === SUBGRAPH_REF_TYPE);
  if (refNodes.length === 0) return { nodes, edges };

  const outNodes: FlowNode[] = nodes.filter((n) => n.data.typeId !== SUBGRAPH_REF_TYPE);
  const outEdges: FlowEdge[] = [];
  /** ref 节点 id -> 其端口映射，用于重定向外部连线 */
  const portMap = new Map<
    string,
    { inputs: Map<string, SubgraphPort>; outputs: Map<string, SubgraphPort> }
  >();

  for (const ref of refNodes) {
    const sgId = String(ref.data.params?.subgraphId ?? '');
    const sg = subgraphs[sgId];
    if (!sg) {
      throw new Error(`子图「${ref.data.label}」引用的定义已丢失（id: ${sgId || '空'}）`);
    }
    if (stack.includes(sgId)) {
      throw new Error(`子图「${sg.name}」存在循环引用，无法展开`);
    }

    // 先把子图自身的内容递归展开（处理嵌套子图）
    const innerFlowNodes: FlowNode[] = sg.nodes.map((n) => ({
      id: n.id,
      type: 'base',
      position: { ...n.position },
      data: { typeId: n.typeId, label: n.label, params: { ...n.params } },
    })) as FlowNode[];
    const innerFlowEdges: FlowEdge[] = sg.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    })) as FlowEdge[];
    const inner = flattenSubgraphs(innerFlowNodes, innerFlowEdges, subgraphs, [...stack, sgId]);

    // 内部节点 id 加前缀后并入主图，位置偏移到 ref 节点附近（不影响执行，仅便于调试）
    for (const n of inner.nodes) {
      outNodes.push({
        ...n,
        id: expandedId(ref.id, n.id),
        position: { x: ref.position.x + n.position.x * 0.1, y: ref.position.y + n.position.y * 0.1 },
        data: { ...n.data, label: `${ref.data.label}/${n.data.label}` },
      });
    }
    for (const e of inner.edges) {
      outEdges.push({
        ...e,
        id: expandedId(ref.id, e.id),
        source: expandedId(ref.id, e.source),
        target: expandedId(ref.id, e.target),
      });
    }

    portMap.set(ref.id, {
      inputs: new Map(sg.inputs.map((p) => [p.id, p])),
      outputs: new Map(sg.outputs.map((p) => [p.id, p])),
    });
  }

  // 重定向跨边界连线
  for (const e of edges) {
    const srcRef = portMap.get(e.source);
    const dstRef = portMap.get(e.target);
    if (!srcRef && !dstRef) {
      outEdges.push(e);
      continue;
    }
    let source = e.source;
    let sourceHandle = e.sourceHandle ?? null;
    let target = e.target;
    let targetHandle = e.targetHandle ?? null;

    if (srcRef) {
      const p = srcRef.outputs.get(e.sourceHandle ?? '');
      if (!p) continue; // 端口已失效（子图改过），丢弃该连线
      source = expandedId(e.source, p.innerNodeId);
      sourceHandle = p.innerHandle;
    }
    if (dstRef) {
      const p = dstRef.inputs.get(e.targetHandle ?? '');
      if (!p) continue;
      target = expandedId(e.target, p.innerNodeId);
      targetHandle = p.innerHandle;
    }
    outEdges.push({ ...e, source, sourceHandle, target, targetHandle });
  }

  return { nodes: outNodes, edges: outEdges };
}
