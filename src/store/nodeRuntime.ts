// 运行态复位的纯映射（清节点状态/错误/输出/用量，去边 running class）。
// 这些函数只依赖传入的节点/连线列表，不触碰 store 单例，可独立测试。
// 从 workflowStore 的 resetStatuses action 内联逻辑抽离，行为等价。

import type { FlowEdge, FlowNode, NodeStatus } from '../types/graph';

/** 把节点列表的运行态字段复位为 idle（供运行结束/中止后清理，避免「卡在 running」） */
export function resetNodeRuntime(
  nodes: FlowNode[],
  options: { preserveOutputs?: boolean } = {},
): FlowNode[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      status: 'idle' as NodeStatus,
      error: undefined,
      outputs: options.preserveOutputs ? n.data.outputs : undefined,
      usage: undefined,
    },
  }));
}

/** 去除连线上的 running 高亮 class（sm-edge-running） */
export function resetEdgeRuntime(edges: FlowEdge[]): FlowEdge[] {
  return edges.map((e) => ({
    ...e,
    className: (e.className ?? '').split(' ').filter((c) => c !== 'sm-edge-running').join(' '),
  }));
}
