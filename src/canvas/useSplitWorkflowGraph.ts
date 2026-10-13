import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { FlowEdge, FlowNode } from '../types/graph';
import type { WorkflowFileInMemory } from '../types/workflow';

/** 拆分视图右栏的目标工作流（只需图的两部分，便于测试与复用）。 */
type SplitWorkflowSource = Pick<WorkflowFileInMemory, 'nodes' | 'edges'>;

interface SplitWorkflowGraphInput {
  isSplit: boolean;
  wfId?: string;
  splitWf: SplitWorkflowSource | undefined;
  updateWorkflowGraph: (id: string, nodes: FlowNode[], edges: FlowEdge[]) => void;
}

interface SplitWorkflowGraph {
  splitNodes: FlowNode[];
  splitEdges: FlowEdge[];
  setSplitNodes: Dispatch<SetStateAction<FlowNode[]>>;
  setSplitEdges: Dispatch<SetStateAction<FlowEdge[]>>;
}

/**
 * 拆分视图右栏：载入 effect ↔ 写回 effect 双向同步。
 *
 * 采用「内容指纹」而非引用比较来切断循环：
 * 载入 effect 依赖 splitWf，写回 effect 依赖 splitNodes，二者在同一 commit 中按声明顺序执行，
 * 若用「引用是否相等」判断回流，载入 effect 先跑时会看到旧 splitWf 而误判外部变化，反复重载导致
 * 「写回 → splitWf 变 → 重载 → 又写回」无限循环（曾导致拆分视图拖拽即卡死）。
 * 指纹是「节点/连线的关键字段序列化」，内容级比较与执行顺序无关，能精准区分「自身回流」与「外部真修改」。
 *
 * 写回 effect 的两道闸门：
 * 1) loadedWfIdRef !== wfId —— 尚未从 store 载入，此时 splitNodes 是初始空数组，写回会把目标工作流清空；
 * 2) 内容指纹与上次写回/载入一致 —— 说明没有用户编辑，跳过以切断死循环（曾打爆 WebView2）。
 */
export default function useSplitWorkflowGraph({
  isSplit,
  wfId,
  splitWf,
  updateWorkflowGraph,
}: SplitWorkflowGraphInput): SplitWorkflowGraph {
  // 分栏工作流：以本地状态维护其图，编辑时写回 workflows 字典
  const [splitNodes, setSplitNodes] = useState<FlowNode[]>([]);
  const [splitEdges, setSplitEdges] = useState<FlowEdge[]>([]);
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

  // 分栏编辑时，把最新图写回 store。
  useEffect(() => {
    if (!isSplit || !wfId) return;
    if (loadedWfIdRef.current !== wfId) return;
    const sig = splitSig(splitNodes, splitEdges);
    if (splitSigRef.current === sig) return;
    splitSigRef.current = sig;
    updateWorkflowGraph(wfId, splitNodes, splitEdges);
  }, [isSplit, wfId, splitNodes, splitEdges, updateWorkflowGraph]);

  return { splitNodes, splitEdges, setSplitNodes, setSplitEdges };
}
