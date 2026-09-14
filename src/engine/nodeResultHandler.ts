/**
 * nodeResultHandler.ts — 节点结果副作用处理（executor 拆分，Codex 建议低风险模块）。
 *
 * 把 executeNode 里「节点执行后的结果收尾」抽为纯函数：
 * - `handleNodeSuccess`：写缓存、登记分支状态、写 success 状态、发 node.completed 事件、
 *   落盘中间快照、stopAfter 剪裁下游
 * - `handleNodeFailure`：登记分支状态（skipFailed 语义）、写 error 状态、发 node.failed 事件、
 *   落盘中间快照、记录错误日志
 *
 * 副作用全部经注入的处理器（setStatus/emit/onSnapshot/onCut 等），不直接依赖 store。
 */

/** 节点结果处理所需的副作用回调。 */
export interface NodeResultHandlers {
  /** 写节点状态（R.setNodeStatus 绑定 wfId） */
  setStatus: (status: Parameters<import('./runtime').ExecutionRuntime['setNodeStatus']>[1], patch?: Record<string, unknown>) => void;
  /** 发节点事件（emitNode 绑定 bus/ctx/nodeId） */
  emit: (kind: 'node.completed' | 'node.failed', payload: Record<string, unknown>) => void;
  /** 中间检查点快照（节流） */
  onSnapshot: () => void;
  /** stopAfter 剪裁（对 id 下游加入 cutSet） */
  onCut: () => void;
  /** 错误日志 */
  onErrorLog: (msg: string) => void;
}

/** 节点成功收尾的输入。 */
export interface NodeSuccessInput {
  id: string;
  node: { data: { typeId: string; label: string; params: Record<string, unknown> } };
  def: { outputs: Array<{ id: string }> };
  outputs: Record<string, unknown>;
  inputs: Record<string, unknown>;
  /** 上游输出（缓存键） */
  upstreamOutputs: Record<string, unknown>;
  cacheScope: string;
  startedAt: string;
  durationMs: number;
  /** 分支节点声明的激活 handle（undefined = 普通节点全部激活） */
  branchesTaken?: string[];
  stopAfter: Set<string>;
  cache: {
    key: (typeId: string, params: Record<string, unknown>, upstream: Record<string, unknown>, scope: string) => string;
    set: (key: string, value: Record<string, unknown>, branches?: readonly string[]) => void;
  };
  outputMap: { set: (id: string, outputs: Record<string, unknown>) => void };
  branchState: { set: (id: string, handles: Set<string | undefined>) => void };
  h: NodeResultHandlers;
}

/** 节点失败收尾的输入。 */
export interface NodeFailureInput {
  id: string;
  node: { data: { label: string; typeId: string } };
  def: { outputs: Array<{ id: string }> };
  message: string;
  startedAt: string;
  durationMs: number;
  skipFailed: boolean;
  branchState: { set: (id: string, handles: Set<string | undefined>) => void };
  h: NodeResultHandlers;
}

/** 节点成功：写缓存 + 登记分支 + 状态/事件/快照/剪裁。 */
export function handleNodeSuccess(input: NodeSuccessInput): void {
  const { id, node, def, outputs, inputs, upstreamOutputs, cacheScope, startedAt, durationMs, branchesTaken, stopAfter, cache, outputMap, branchState, h } = input;

  outputMap.set(id, outputs);
  // 写入缓存：以「类型+参数+上游输出+工作流scope」为 key，下游命中时自动复用
  const key = cache.key(node.data.typeId, node.data.params, upstreamOutputs, cacheScope);
  if (branchesTaken !== undefined) cache.set(key, outputs, branchesTaken);
  else cache.set(key, outputs);
  // 登记分支状态：分支节点用其声明的激活 handle，普通节点视为全部输出端口激活
  branchState.set(
    id,
    branchesTaken !== undefined ? new Set(branchesTaken) : new Set(def.outputs.map((o) => o.id)),
  );
  h.setStatus('success', {
    outputs,
    startedAt,
    durationMs,
  });
  h.emit('node.completed', {
    status: 'success',
    label: node.data.label,
    typeId: node.data.typeId,
    outputs,
    durationMs,
  });
  // 阶段 G2：节点成功后落盘中间快照（节流）——崩溃恢复可见该节点成果
  h.onSnapshot();
  if (stopAfter.has(id)) h.onCut();
  void inputs;
}

/** 节点失败：登记分支（skipFailed 语义）+ 状态/事件/快照/日志。 */
export function handleNodeFailure(input: NodeFailureInput): void {
  const { id, node, def, message, startedAt, durationMs, skipFailed, branchState, h } = input;

  if (skipFailed) {
    // 跳过失败模式：失败节点不屏蔽下游，使下游仍能以空上游输出继续尝试
    branchState.set(id, new Set(def.outputs.map((o) => o.id)));
  } else {
    branchState.set(id, new Set()); // 失败节点视为屏蔽下游
  }
  h.setStatus('error', {
    error: message,
    startedAt,
    durationMs,
  });
  h.emit('node.failed', {
    error: message,
    label: node.data.label,
    typeId: node.data.typeId,
    durationMs,
  });
  // 阶段 G2：节点失败也落盘快照（记录失败位置，恢复时可从此续跑）
  h.onSnapshot();
  h.onErrorLog(`「${node.data.label}」这一步出错了：${message}`);
}
