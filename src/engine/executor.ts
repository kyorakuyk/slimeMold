import type { ExecContext, FlowEdge, FlowNode } from '../types';
import { topoLayers } from './topoSort';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { chatWithAgent } from '../agents/agentManager';
import { scopedStorage } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';

let currentAbort: AbortController | null = null;

export function stopWorkflow(): void {
  currentAbort?.abort();
}

/** 汇集上游输出：edge.targetHandle <- outputs[edge.source][edge.sourceHandle] */
function collectInputs(
  nodeId: string,
  edges: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const upstream = outputsMap.get(e.source);
    if (!upstream) continue;
    const value = upstream[e.sourceHandle ?? ''];
    inputs[e.targetHandle ?? ''] = value;
  }
  return inputs;
}

export async function runWorkflow(): Promise<void> {
  const wf = useWorkflowStore.getState();
  if (wf.running) return;
  const { nodes, edges, failFast } = wf;
  if (nodes.length === 0) {
    wf.addLog('error', '画布为空，请先添加节点');
    return;
  }

  const { layers, cyclic } = topoLayers(
    nodes.map((n) => n.id),
    edges,
  );
  if (cyclic.length > 0) {
    for (const id of cyclic) {
      wf.setNodeStatus(id, 'error', { error: '处于环路中，无法执行' });
    }
    wf.addLog('error', `检测到环路，涉及 ${cyclic.length} 个节点，已终止`);
    return;
  }

  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  wf.setRunning(true);
  wf.resetStatuses();

  // 并发限流：同一时刻最多 maxConcurrency 个 LLM 请求在进行
  const limiter = new Semaphore(Math.max(1, wf.maxConcurrency ?? 3));
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;

  wf.addLog('info', `开始执行「${wf.workflowName}」，共 ${nodes.length} 个节点、${layers.length} 层，并发上限 ${wf.maxConcurrency ?? 3}`);

  const outputsMap = new Map<string, Record<string, unknown>>();
  const failed = new Set<string>();
  const nodeById = new Map<string, FlowNode>(nodes.map((n) => [n.id, n]));
  const startAt = performance.now();

  for (const layer of layers) {
    if (signal.aborted) break;
    // 同层节点相互独立，可并行调度（瓶颈在 LLM I/O）
    await Promise.all(
      layer.map((id) =>
        executeNode(id, nodeById, edges, outputsMap, failed, signal, limiter, MAX_RETRIES, RETRY_BASE_MS),
      ),
    );
    if (failFast && failed.size > 0) {
      currentAbort.abort();
      break;
    }
  }

  const store = useWorkflowStore.getState();
  const elapsed = ((performance.now() - startAt) / 1000).toFixed(1);
  if (signal.aborted && failed.size === 0) {
    store.addLog('info', `执行已手动停止（${elapsed}s）`);
  } else if (failed.size > 0) {
    store.addLog('error', `执行结束：${failed.size} 个节点失败（${elapsed}s）`);
  } else {
    store.addLog('info', `执行完成，全部节点成功（${elapsed}s）`);
  }
  store.setRunning(false);
  currentAbort = null;
}

async function executeNode(
  id: string,
  nodeById: Map<string, FlowNode>,
  edges: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
  failed: Set<string>,
  signal: AbortSignal,
  limiter: Semaphore,
  MAX_RETRIES: number,
  RETRY_BASE_MS: number,
): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = nodeById.get(id);
  if (!node || signal.aborted) return;

  // 上游失败传染：直接标记失败，不执行
  const upstreamFailed = edges.some((e) => e.target === id && failed.has(e.source));
  if (upstreamFailed) {
    failed.add(id);
    store.setNodeStatus(id, 'error', { error: '上游节点失败，已跳过' });
    return;
  }

  const def = useRegistryStore.getState().defs[node.data.typeId];
  if (!def || def.missing) {
    failed.add(id);
    store.setNodeStatus(id, 'error', {
      error: `节点类型 ${node.data.typeId} 缺失（可能来自未加载的插件）`,
    });
    return;
  }

  const ctx: ExecContext = {
    signal,
    logger: {
      info: (m) => store.addLog('info', `[${node.data.label}] ${m}`),
      error: (m) => store.addLog('error', `[${node.data.label}] ${m}`),
    },
    llm: async (agentId, messages, onToken) => {
      const agent = useWorkflowStore
        .getState()
        .agents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`智能体不存在: ${agentId}`);
      // 并发限流 + 限流重试（指数退避），仅对 LLM 调用生效
      const release = await limiter.acquire();
      try {
        return await withRetry(
          () => chatWithAgent(agent, messages, signal, onToken),
          {
            retries: MAX_RETRIES,
            baseDelay: RETRY_BASE_MS,
            signal,
            onRetry: (msg, delay, attempt) =>
              store.addLog(
                'error',
                `[${node.data.label}] 限流重试(${attempt}/${MAX_RETRIES})：${msg}，等待 ${delay}ms`,
              ),
          },
        );
      } finally {
        release();
      }
    },
    setPartial: (key, value) => {
      const cur =
        useWorkflowStore.getState().nodes.find((n) => n.id === id)?.data.outputs ?? {};
      useWorkflowStore.getState().setNodeStatus(id, 'running', {
        outputs: { ...cur, [key]: value },
      });
    },
    storage: scopedStorage(def.pluginId ?? 'core'),
  };

  store.setNodeStatus(id, 'running');
  const inputs = collectInputs(id, edges, outputsMap);
  try {
    const outputs = await def.execute(inputs, node.data.params, ctx);
    outputsMap.set(id, outputs ?? {});
    store.setNodeStatus(id, 'success', { outputs: outputs ?? {} });
  } catch (err) {
    // 插件/节点异常隔离：捕获并标记失败，不影响主应用
    const message = err instanceof Error ? err.message : String(err);
    failed.add(id);
    store.setNodeStatus(id, 'error', { error: message });
    store.addLog('error', `[${node.data.label}] 执行失败：${message}`);
  }
}
