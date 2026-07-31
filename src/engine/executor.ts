import type { ExecContext, FlowEdge, FlowNode, NodeStatus, RunRecord } from '../types';
import { topoLayers } from './topoSort';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { chatWithAgent } from '../agents/agentManager';
import { scopedStorage } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';
import {
  beginRun,
  cacheKey,
  countSkip,
  getCached,
  setCached,
  skippedCount,
  strike,
} from './nodeCache';

let currentAbort: AbortController | null = null;

export function stopWorkflow(): void {
  currentAbort?.abort();
}

/** 汇集上游输出：edge.targetHandle <- outputs[edge.source][edge.sourceHandle] */
export function collectInputs(
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

export interface RunOptions {
  /** 增量模式：只执行脏节点及其下游（非脏节点复用已有/缓存结果） */
  incremental?: boolean;
  /** 强制重算的节点集合（重跑单节点时使用），会清除其缓存 */
  forceNodes?: string[];
  /** 执行到这些节点为止（含），其下游不再执行（标记 skipped）。用于「重跑到此节点」 */
  stopAfterNodes?: string[];
}

export async function runWorkflow(opts: RunOptions = {}): Promise<void> {
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

  const force = new Set(opts.forceNodes ?? []);
  const stopAfter = new Set(opts.stopAfterNodes ?? []);
  // 全量运行：清除所有脏标记（之后全部节点都视为需执行，命中缓存者跳过）
  // 增量运行：保留脏标记，仅执行脏节点及其下游
  if (!opts.incremental) {
    wf.clearDirty();
    for (const id of force) strike(wf.nodes.find((n) => n.id === id)?.data.typeId ?? '');
  } else {
    for (const id of force) strike(wf.nodes.find((n) => n.id === id)?.data.typeId ?? '');
  }
  // 未显式 force 的增量运行：以当前 data.dirty 决定执行集
  const dirtySet = new Set(nodes.filter((n) => n.data.dirty).map((n) => n.id));
  for (const id of force) dirtySet.add(id);

  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  wf.setRunning(true);
  wf.resetStatuses();
  beginRun();

  // 并发限流：同一时刻最多 maxConcurrency 个 LLM 请求在进行
  const limiter = new Semaphore(Math.max(1, wf.maxConcurrency ?? 3));
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;

  const modeLabel = opts.incremental ? '增量' : '全量';
  wf.addLog('info', `开始${modeLabel}执行「${wf.workflowName}」，共 ${nodes.length} 个节点、${layers.length} 层，并发上限 ${wf.maxConcurrency ?? 3}`);

  const outputsMap = new Map<string, Record<string, unknown>>();
  // 预填已存在且非脏节点的输出，作为下游依赖输入（增量模式下复用既有结果）
  for (const n of nodes) {
    if (!dirtySet.has(n.id) && n.data.outputs) {
      outputsMap.set(n.id, n.data.outputs);
    }
  }
  // 分支状态：nodeId -> 激活的输出 handle 集合。
  //  - 未登记：视为该节点所有输出 handle 均激活（普通节点缺省语义）
  //  - 空集合：全部屏蔽（被剪枝的下游节点登记此值，使其更下游也被剪枝）
  //  - 具体 handle：仅列出的分支端口激活（条件节点声明）
  const branchState = new Map<string, Set<string | undefined>>();
  const failed = new Set<string>();
  // 裁剪集合：stopAfter 节点的下游会被加入此集合并在调度前跳过（标记 skipped）
  const cutSet = new Set<string>();
  const nodeById = new Map<string, FlowNode>(nodes.map((n) => [n.id, n]));
  const startAt = performance.now();
  const startedWall = Date.now();

  for (const layer of layers) {
    if (signal.aborted) break;
    // 同层节点相互独立，可并行调度（瓶颈在 LLM I/O）
    await Promise.all(
      layer.map((id) =>
        executeNode(
          id,
          nodeById,
          edges,
          outputsMap,
          branchState,
          failed,
          cutSet,
          stopAfter,
          signal,
          limiter,
          MAX_RETRIES,
          RETRY_BASE_MS,
          dirtySet.has(id),
          force.has(id),
        ),
      ),
    );
    if (failFast && failed.size > 0) {
      currentAbort.abort();
      break;
    }
  }

  const store = useWorkflowStore.getState();
  const elapsed = ((performance.now() - startAt) / 1000).toFixed(1);
  const skipped = skippedCount();
  // 分支剪枝 / 被上游失败跳过的节点数（结束态为 'skipped'）
  const pruned = store.nodes.filter((n) => n.data.status === 'skipped').length;
  if (signal.aborted && failed.size === 0) {
    store.addLog('info', `执行已手动停止（${elapsed}s）`);
  } else if (failed.size > 0) {
    store.addLog('error', `执行结束：${failed.size} 个节点失败（${elapsed}s）`);
  } else {
    const skipMsg = skipped > 0 ? `，缓存命中 ${skipped}` : '';
    const pruneMsg = pruned > 0 ? `、分支跳过 ${pruned}` : '';
    store.addLog('info', `执行完成，全部节点成功（${elapsed}s${skipMsg}${pruneMsg}）`);
  }

  // 记录运行历史（持久化到 localStorage）
  const nodesNow = useWorkflowStore.getState().nodes;
  const status: RunRecord['status'] =
    failed.size > 0 ? 'error' : signal.aborted ? 'aborted' : 'success';
  const rec: RunRecord = {
    id: `run_${Date.now()}`,
    name: wf.workflowName,
    startedAt: new Date(startedWall).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startAt),
    status,
    nodeCount: nodes.length,
    nodes: nodesNow.map((n) => ({
      id: n.id,
      label: n.data.label,
      typeId: n.data.typeId,
      status: n.data.status ?? 'idle',
      outputs: n.data.outputs ?? null,
      error: n.data.error ?? null,
      startedAt: n.data.startedAt ?? null,
      durationMs: n.data.durationMs ?? null,
    })),
  };
  useWorkflowStore.getState().pushRunHistory(rec);

  store.setRunning(false);
  currentAbort = null;
}

/** 将 startId 的全部下游节点加入 cutSet（BFS） */
function addDownstreamToCut(startId: string, edges: FlowEdge[], cutSet: Set<string>): void {
  const queue = [startId];
  const seen = new Set([startId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !seen.has(e.target)) {
        seen.add(e.target);
        cutSet.add(e.target);
        queue.push(e.target);
      }
    }
  }
}

async function executeNode(
  id: string,
  nodeById: Map<string, FlowNode>,
  edges: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
  branchState: Map<string, Set<string | undefined>>,
  failed: Set<string>,
  cutSet: Set<string>,
  stopAfter: Set<string>,
  signal: AbortSignal,
  limiter: Semaphore,
  MAX_RETRIES: number,
  RETRY_BASE_MS: number,
  shouldRun: boolean,
  forced: boolean,
): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = nodeById.get(id);
  if (!node || signal.aborted) return;

  const incoming = edges.filter((e) => e.target === id);

  // 上游失败传染：直接标记失败，不执行（其下游会因 failed 集合被继续传染）
  const upstreamFailed = incoming.some((e) => failed.has(e.source));
  if (upstreamFailed) {
    failed.add(id);
    branchState.set(id, new Set());
    store.setNodeStatus(id, 'error', {
      error: '上游节点失败，已跳过',
      startedAt: null,
      durationMs: null,
    });
    return;
  }

  const def = useRegistryStore.getState().defs[node.data.typeId];
  if (!def || def.missing) {
    failed.add(id);
    branchState.set(id, new Set());
    store.setNodeStatus(id, 'error', {
      error: `节点类型 ${node.data.typeId} 缺失（可能来自未加载的插件）`,
    });
    return;
  }

  // 增量模式下被跳过的节点：上游输出已被预填，直接复用，不执行也不改写状态
  if (!shouldRun && !forced) {
    store.setNodeStatus(id, node.data.status === 'cached' ? 'cached' : (node.data.status ?? 'idle'));
    return;
  }

  // 分支剪枝：若所有入边都来自「分支节点且未被激活」的分支，则整条子图跳过
  if (incoming.length > 0) {
    const allBlocked = incoming.every((e) => {
      const s = branchState.get(e.source);
      // 未登记（普通节点缺省）= 全激活；已登记且不含该 handle = 屏蔽
      return s !== undefined && !s.has(e.sourceHandle);
    });
    if (allBlocked) {
      branchState.set(id, new Set()); // 被剪枝：其下游也一并剪枝
      store.setNodeStatus(id, 'skipped', { startedAt: null, durationMs: null });
      return;
    }
  }

  // 裁剪：stopAfter 节点的下游不再执行（其本身已执行完毕）
  if (cutSet.has(id)) {
    branchState.set(id, new Set());
    store.setNodeStatus(id, 'skipped', { startedAt: null, durationMs: null });
    return;
  }

  // 缓存命中判断：相同 类型+参数+上游输出 直接复用结果（forced 时已在 runWorkflow 内 strike）
  if (!forced) {
    const upstreamOutputs = collectInputs(id, edges, outputsMap);
    const key = cacheKey(node.data.typeId, node.data.params, upstreamOutputs);
    const cached = getCached(key);
    if (cached) {
      outputsMap.set(id, cached);
      // 命中缓存的普通节点视为全部输出端口激活
      branchState.set(id, new Set(def.outputs.map((o) => o.id)));
      countSkip();
      store.setNodeStatus(id, 'cached', {
        outputs: cached,
        startedAt: null,
        durationMs: null,
      });
      if (stopAfter.has(id)) addDownstreamToCut(id, edges, cutSet);
      return;
    }
  }

  let branchesTaken: string[] | undefined;
  const ctx: ExecContext = {
    signal,
    logger: {
      info: (m) => store.addLog('info', `[${node.data.label}] ${m}`),
      error: (m) => store.addLog('error', `[${node.data.label}] ${m}`),
    },
    llm: async (agentId, messages, onToken, modelOverride) => {
      const agent = useWorkflowStore
        .getState()
        .agents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`智能体不存在: ${agentId}`);
      const effective = modelOverride
        ? { ...agent, model: modelOverride }
        : agent;
      // 并发限流 + 限流重试（指数退避），仅对 LLM 调用生效
      const release = await limiter.acquire();
      try {
        return await withRetry(
          () => chatWithAgent(effective, messages, signal, onToken),
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
    setBranches: (handles) => {
      branchesTaken = handles;
    },
    storage: scopedStorage(def.pluginId ?? 'core'),
    vars: useWorkflowStore.getState().variables,
  };

  store.setNodeStatus(id, 'running');
  const inputs = collectInputs(id, edges, outputsMap);
  const startedAt = Date.now();
  const perfStart = performance.now();
  try {
    const outputs = await def.execute(inputs, node.data.params, ctx);
    outputsMap.set(id, outputs ?? {});
    // 写入缓存：以「类型+参数+上游输出」为 key，下游命中时自动复用
    const key = cacheKey(node.data.typeId, node.data.params, inputs);
    setCached(key, outputs ?? {});
    // 登记分支状态：分支节点用其声明的激活 handle，普通节点视为全部输出端口激活
    branchState.set(
      id,
      branchesTaken !== undefined
        ? new Set(branchesTaken)
        : new Set(def.outputs.map((o) => o.id)),
    );
    store.setNodeStatus(id, 'success', {
      outputs: outputs ?? {},
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
    });
    if (stopAfter.has(id)) addDownstreamToCut(id, edges, cutSet);
  } catch (err) {
    // 插件/节点异常隔离：捕获并标记失败，不影响主应用
    const message = err instanceof Error ? err.message : String(err);
    failed.add(id);
    branchState.set(id, new Set()); // 失败节点视为屏蔽下游
    store.setNodeStatus(id, 'error', {
      error: message,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
    });
    store.addLog('error', `[${node.data.label}] 执行失败：${message}`);
  }
}

/**
 * 重跑单个节点（及其下游）：标记该节点为脏并强制重算（清除其缓存），
 * 再以增量模式运行——等价于 ComfyUI 的「重跑该子图」。
 * 上游结果直接复用，避免重复调用。
 */
export async function retryNode(id: string): Promise<void> {
  const store = useWorkflowStore.getState();
  if (!store.nodes.some((n) => n.id === id)) throw new Error('节点不存在');
  if (store.running) return;
  store.markDirty(id);
  await runWorkflow({ incremental: true, forceNodes: [id] });
}

/**
 * 重跑到指定节点为止：执行该节点及其上游链（上游脏则重算、否则复用缓存），
 * 但该节点完成之后其下游不再执行（标记 skipped）。用于「中断粒度」——只跑部分子图。
 */
export async function runToNode(id: string): Promise<void> {
  const store = useWorkflowStore.getState();
  if (!store.nodes.some((n) => n.id === id)) throw new Error('节点不存在');
  if (store.running) return;
  store.markDirty(id);
  await runWorkflow({ incremental: true, forceNodes: [id], stopAfterNodes: [id] });
}

