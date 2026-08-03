import type {
  CostRecord,
  ExecContext,
  FlowEdge,
  FlowNode,
  NodeStatus,
  NodeUsageStat,
  RunRecord,
} from '../types';
import { topoStages } from './topoSort';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { getChannel } from '../agents/llmChannel';
import { scopedStorage } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';
import { flattenSubgraphs, ownerRefId } from './subgraph';
import {
  beginRun,
  cacheKey,
  clearCache,
  countSkip,
  getCached,
  setCached,
  skippedCount,
  strike,
} from './nodeCache';

let currentAbort: AbortController | null = null;
/**
 * 运行代次（run generation）：每次启动 runWorkflow 自增并取走当前代次号；
 * stopWorkflow 会自增它，使仍在后台的「旧协程」在下一层边界发现自己已过期，
 * 从而静默退出、不再触碰 store 状态（这是「刷新键失效」的根因：
 * 旧 runWorkflow 卡在某节点 await，resetStatuses 只清了 UI 标志却杀不掉协程，
 * 旧协程恢复后又把 running 复位、与新的运行互相干扰）。
 */
let currentRunId = 0;
/** 当前真正在跑的代次；等于 currentRunId 表示有运行有效，stopWorkflow 会使二者不等 */
let activeRunId = 0;

/** 把运行代次同步到 store 供状态栏诊断显示 */
function syncDebugRun(): void {
  useWorkflowStore.getState().setDebugRun({ current: currentRunId, active: activeRunId });
}

// 节点级实时重试（仅瞬时错误）：与 LLM 网络层重试互补，
// 应对 LLM 层重试耗尽后仍偶发的瞬时故障（持续 429/网关超时等）
const NODE_RETRIES = 2;
const NODE_RETRY_BASE_MS = 1500;

export function stopWorkflow(): void {
  currentRunId += 1; // 让旧协程过期
  activeRunId = 0; // 当前无有效运行
  currentAbort?.abort();
  currentAbort = null;
  // 直接复位 running，不依赖旧协程退出（旧协程可能卡在无法被 abort 的 await 上）。
  // 否则 running 永远为 true，启动键会渲染成"停止键"，点它又变成一次空 stop。
  useWorkflowStore.getState().setRunning(false);
  useWorkflowStore.getState().setRunProgress({ active: false });
  syncDebugRun();
}

/**
 * 强制重跑：清空缓存后全量重新执行当前工作流。
 * 等价于在运行入口传入 forceRerun，供菜单/快捷键直接调用。
 */
export async function rerunWorkflow(): Promise<void> {
  return runWorkflow({ forceRerun: true });
}

/**
 * 判断错误是否为「瞬时错误」：仅这类（网络/超时/限流/网关）值得在节点层重试；
 * 业务错误（参数/解析/逻辑）重试无意义，直接失败。
 */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONN|ENOTFOUND|ECONNRESET|ETIMEDOUT|429|too many requests|503|502|504|gateway|rate limit|network|socket|aborted/i.test(
    msg,
  );
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
  /**
   * 失败续跑（L1 可靠执行）：仅重跑上一轮处于 error 状态的节点及其下游；
   * 其余 success/cached 节点复用既有结果不动。需配合 incremental 使用。
   */
  retryFailed?: boolean;
  /** 强制轮次上限（调试用），默认取 loopGate 节点的 maxLoops 参数 */
  maxLoopsOverride?: number;
  /**
   * 失败时继续（failFast 的反面策略）：为 true 时，某节点失败后不中断整体运行，
   * 且其下游节点不被剪枝、以空上游输出继续尝试执行（跳过失败节点而非卡死）。
   * 配合 false 的 failFast 一起使用。
   */
  skipFailed?: boolean;
  /**
   * 强制重跑：清空节点结果缓存（nodeCache），使所有节点无论参数是否变化都重新执行，
   * 不复用上一轮的 LLM 结果。等价于 ComfyUI 的「忽略缓存重新执行」。
   */
  forceRerun?: boolean;
  /**
   * 调度进度回调（供 Job Board 等可视化）：每一层开始前上报当前层索引、总层数、轮次。
   */
  onProgress?: (p: { layer: number; totalLayers: number; round: number; totalRounds: number }) => void;
}

export async function runWorkflow(opts: RunOptions = {}): Promise<void> {
  const wf = useWorkflowStore.getState();
  // 若上一次运行仍有效（activeRunId 与最新代次一致，即未被停止过）才阻止并发重入；
  // 若已被 stopWorkflow 自增代次，则允许新启动（解决「刷新键后启动键失效」）。
  // 注意：currentRunId/activeRunId 是模块级变量，HMR 热更新会将其归零；若此时
  // running 残留为 true（旧协程未复位），会误判为「有效运行」而静默拦截导致
  // 「点运行无反应也无日志」。这里在拦截时给出可见日志，便于排查；并允许 force
  // 强制重启（Play 按钮在检测到卡死时透传），避免永久卡死。
  if (wf.running && activeRunId === currentRunId) {
    if (opts.force) {
      wf.addLog('warn', '检测到运行态残留，已强制重启运行（忽略并发拦截）');
    } else {
      wf.addLog('warn', '上一次运行仍在有效进行中，已忽略重复启动（如需强制重启请先停止）');
      return;
    }
  }
  const myRun = ++currentRunId; // 本次运行代次
  activeRunId = myRun;
  syncDebugRun();
  const { failFast } = wf;
  if (wf.nodes.length === 0) {
    wf.addLog('error', '还没放任何节点，先把节点拖到画布上吧');
    return;
  }

  // 子图扁平化：把 subgraph.ref 节点就地展开成内部节点，
  // 之后整条执行链路（拓扑/缓存/剪枝/增量）看到的都是一张普通扁平图。
  let nodes: FlowNode[];
  let edges: FlowEdge[];
  try {
    const flat = flattenSubgraphs(wf.nodes, wf.edges, wf.subgraphs);
    nodes = flat.nodes;
    edges = flat.edges;
  } catch (err) {
    wf.addLog('error', err instanceof Error ? err.message : String(err));
    return;
  }
  const expandedCount = nodes.length - wf.nodes.length;
  if (expandedCount > 0) {
    wf.addLog('info', `已展开子图，新增 ${expandedCount} 个内部步骤`);
  }

  // 控制流（control）边作为 stage 断点，不计入 DAG 环检测；data/task 边参与拓扑
  const dataEdges = edges
    .filter((e) => (e.data?.kind ?? 'data') !== 'control')
    .map((e) => ({ source: e.source, target: e.target }));
  const controlEdges = edges
    .filter((e) => (e.data?.kind ?? 'data') === 'control')
    .map((e) => ({ source: e.source, target: e.target }));
  const { stages, cyclic } = topoStages(
    nodes.map((n) => n.id),
    dataEdges,
    controlEdges,
  );
  if (cyclic.length > 0) {
    const labels = cyclic
      .map((id) => nodes.find((n) => n.id === id)?.data.label ?? id)
      .join('、');
    for (const id of cyclic) {
      wf.setNodeStatus(id, 'error', { error: '这几个节点连成了死循环，请拆掉其中一条连线' });
    }
    wf.addLog('error', `有节点连成了死循环（${labels}），请拆掉其中一条连线后再运行`);
    return;
  }

  const force = new Set(opts.forceNodes ?? []);
  const stopAfter = new Set(opts.stopAfterNodes ?? []);
  // 失败续跑（L1）：把上一轮 error 节点及其全部下游标记为本次需执行集
  if (opts.retryFailed) {
    const errored = nodes.filter((n) => n.data.status === 'error').map((n) => n.id);
    for (const id of errored) {
      const downstream = new Set<string>();
      addDownstreamToCut(id, edges, downstream); // 含 errored 自身
      for (const d of downstream) force.add(d);
    }
  }
  // 全量运行：清除所有脏标记（之后全部节点都视为需执行，命中缓存者跳过）
  // 增量运行：保留脏标记，仅执行脏节点及其下游
  if (!opts.incremental && !opts.retryFailed) {
    wf.clearDirty();
    for (const id of force) strike(wf.nodes.find((n) => n.id === id)?.data.typeId ?? '');
  } else {
    for (const id of force) strike(wf.nodes.find((n) => n.id === id)?.data.typeId ?? '');
  }
  // 未显式 force 的增量运行：以当前 data.dirty 决定执行集
  const dirtySet = new Set(nodes.filter((n) => n.data.dirty).map((n) => n.id));
  for (const id of force) dirtySet.add(id);
  // 子图展开出的虚拟节点不存在于画布，没有独立的脏标记与既有输出可复用，
  // 一律视为「需执行」——真正的重复计算由 nodeCache 按 类型+参数+上游输出 拦截。
  for (const n of nodes) {
    if (ownerRefId(n.id)) dirtySet.add(n.id);
  }

  // 检测是否存在「循环迭代」结构：loopGate 的 pass(control) 分支指回其某个上游。
  // 若存在，执行引擎将重复跑整个 stage 序列（多轮）；否则单轮即可。
  const loopGates = nodes.filter((n) => n.data.typeId === 'flow.loopGate');
  const loopGateIds = new Set(loopGates.map((n) => n.id));
  // 每个 loopGate 的循环变量名（缺省 'i'）与最大轮数
  const loopVarOf = new Map<string, string>();
  const maxLoopsOf = new Map<string, number>();
  for (const g of loopGates) {
    loopVarOf.set(g.id, String((g.data.params as Record<string, unknown>)?.loopVar ?? 'i'));
    maxLoopsOf.set(g.id, Number((g.data.params as Record<string, unknown>)?.maxLoops ?? 20));
  }
  // 计算 loopGate 的「循环体」节点集：从 gate.pass 出发、沿控制/数据边、在被 gate.control 回指之前可达的节点
  const hasLoop = loopGates.length > 0 &&
    controlEdges.some((e) => loopGateIds.has(e.source) && isReachable(e.target, e.source, edges));
  // 预计算：每个 loopGate 的循环体下游集（用于每轮强制重算）
  const loopBodyOf = new Map<string, Set<string>>();
  if (hasLoop) {
    for (const g of loopGates) {
      const body = new Set<string>();
      // 从 pass 端口出发可达、且能绕回 gate 的节点
      const seed = controlEdges.filter((e) => e.source === g.id).map((e) => e.target);
      for (const s of seed) collectReachable(s, g.id, edges, body);
      loopBodyOf.set(g.id, body);
    }
  }

  // 强制重跑：清空全局节点缓存，使所有节点都重新执行（不复用上一轮 LLM 结果）
  if (opts.forceRerun) {
    clearCache();
    wf.addLog('info', '已清空节点结果缓存，本轮将全量重新执行（强制重跑）');
  }

  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  wf.setRunning(true);
  wf.resetStatuses();
  // 清空运行期成本账本，供 Companion 浮窗实时展示
  useWorkflowStore.getState().resetUsage();
  beginRun();

  // 并发限流：同一时刻最多 maxConcurrency 个 LLM 请求在进行
  const limiter = new Semaphore(Math.max(1, wf.maxConcurrency ?? 3));
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;
  const skipFailed = !!opts.skipFailed;

  const modeLabel = opts.incremental ? '接着上次接着跑' : '从头开始';
  wf.addLog('info', `开始运行（${modeLabel}），一共 ${nodes.length} 个节点`);

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

  // 成本账本：运行期累积全部 LLM 调用的 token 用量与耗时（Auditor / 自优化闭环）
  const costLog: CostRecord[] = [];
  const costByNode = new Map<string, CostRecord[]>();

  // 每个 loopGate 本轮走的分支端口（来自 setBranches 回调）
  const gateTaken = new Map<string, string[]>();
  // 每轮注入的循环变量：loopVar 名 -> 当前轮次值
  const loopVarsState: Record<string, number> = {};
  for (const gid of loopGateIds) loopVarsState[loopVarOf.get(gid)!] = 0;

  // 整体轮次循环：存在 control 回环时重复跑整个 stage 序列（Step 6 迭代循环）
  const maxRounds = opts.maxLoopsOverride ?? Math.min(50, Math.max(1, ...maxLoopsOf.values()));
  let round = 0;
  let loopContinued = false;
  do {
    if (round > 0) {
      wf.addLog('info', `循环第 ${round + 1} 轮开始（最大 ${maxRounds} 轮）`);
    }
    // 每轮前：把本轮循环变量注入 dirtySet/force，使循环体节点强制重算
    if (round > 0) {
      for (const [gid, body] of loopBodyOf) {
        for (const bid of body) {
          dirtySet.add(bid);
          force.add(bid);
          // 清缓存，避免循环体命中上一轮的缓存结果
          strike(nodeById.get(bid)?.data.typeId ?? '');
        }
        // 循环变量递增
        const lv = loopVarOf.get(gid)!;
        loopVarsState[lv] = round;
      }
    }
    for (const layer of stages) {
      if (signal.aborted || myRun !== currentRunId) break;
      // 上报调度进度（层索引 / 总层数 / 当前轮次 / 总轮次）
      const progress = {
        layer: stages.indexOf(layer) + 1,
        totalLayers: stages.length,
        round: round + 1,
        totalRounds: maxRounds,
      };
      opts.onProgress?.(progress);
      useWorkflowStore.getState().setRunProgress({ active: true, ...progress });
      // 同 stage 内节点相互独立，可并行调度（瓶颈在 LLM I/O）；
      // 控制流（control）边已保证 stage 间严格有序，循环/条件断点不破坏检测。
      // B-full 串行化：若同 stage 内多个节点通过 task 边声明了**相交的影响域(scope)**，
      // 说明它们会争用同一资源，强制把它们归到同一「串行簇」内按序执行，消解并发冲突；
      // 互不冲突的节点仍保持并行（簇间并行、簇内串行），最大化并行度。
      const scopesOf = (id: string): string[] => {
        const set = new Set<string>();
        for (const e of edges) {
          if (e.target === id && Array.isArray(e.data?.scope)) {
            for (const s of e.data.scope as string[]) set.add(s);
          }
        }
        return [...set];
      };
      const t0 = performance.now();
      // 基于冲突关系（scope 相交）的并查集：冲突的节点强制并入同一串行簇，
      // 不同连通分量之间仍并行，最大化并行度（替代朴素贪心，避免多对冲突时错误分组）。
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r)!;
        let c = x;
        while (parent.get(c) !== r) {
          const n = parent.get(c)!;
          parent.set(c, r);
          c = n;
        }
        return r;
      };
      const union = (a: string, b: string) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
      };
      // 预先把本层所有节点初始化进并查集，避免内层访问未初始化节点导致 find 返回 undefined
      for (const id of layer) parent.set(id, id);
      for (const id of layer) {
        const sc = scopesOf(id);
        // 找本层内与当前节点 scope 相交的其他节点，标记冲突并合并
        for (const other of layer) {
          if (other === id) continue;
          const os = scopesOf(other);
          if (sc.some((s) => os.includes(s))) union(id, other);
        }
      }
      const groupOf = new Map<string, string[]>();
      for (const id of layer) {
        const root = find(id);
        if (!groupOf.has(root)) groupOf.set(root, []);
        groupOf.get(root)!.push(id);
      }
      const clusters = [...groupOf.values()];
      // 簇间并行；每个簇内按列表顺序串行执行（冲突节点被挤进同一簇）
      await Promise.all(
        clusters.map((cluster) =>
          (async () => {
            for (const id of cluster) {
              if (signal.aborted || myRun !== currentRunId) break;
              await executeNode(
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
                costLog,
                costByNode,
                { ...loopVarsState }, // 本轮循环变量（仅注入，不污染用户全局变量）
                (gid, handles) => gateTaken.set(gid, handles),
                opts.skipFailed,
                !!opts.incremental,
                myRun,
              );
            }
          })(),
        ),
      );
      if (failFast && failed.size > 0) {
        currentAbort.abort();
        break;
      }
      // failFast=false 且开启「跳过失败继续」：不中断，继续下一 stage
      // （失败节点的下游会在 executeNode 内判定为「跳过失败」而非剪枝）
    }
    if (signal.aborted || myRun !== currentRunId) break;

    // 判断是否需要继续迭代：任一 loopGate 本轮走了 pass 分支 ⇒ 循环体被激活 ⇒ 继续
    loopContinued = hasLoop && [...loopGateIds].some((gid) => {
      const taken = gateTaken.get(gid);
      return taken ? taken.includes('pass') : false;
    });
    gateTaken.clear();
    round += 1;
    if (loopContinued && round >= maxRounds) {
      wf.addLog('info', `已达到最大循环轮数 ${maxRounds}，强制结束循环`);
      loopContinued = false;
    }
  } while (loopContinued);
  if (hasLoop && round > 1) {
    wf.addLog('info', `循环结束，共执行 ${round} 轮`);
  }

  const store = useWorkflowStore.getState();
  const elapsed = ((performance.now() - startAt) / 1000).toFixed(1);
  const skipped = skippedCount();
  // 分支剪枝 / 被上游失败跳过的节点数（结束态为 'skipped'）
  const pruned = store.nodes.filter((n) => n.data.status === 'skipped').length;
  if (signal.aborted && failed.size === 0) {
    store.addLog('info', `已手动停止（用时 ${elapsed}s）`);
  } else if (failed.size > 0) {
    store.addLog(
      'error',
      `有 ${failed.size} 个步骤没跑通，请检查标红的节点（用时 ${elapsed}s）`,
    );
  } else {
    const skipMsg = skipped > 0 ? `，${skipped} 步用了缓存结果` : '';
    const pruneMsg = pruned > 0 ? `，${pruned} 步因条件不成立而跳过` : '';
    store.addLog('info', `全部完成 ✓（用时 ${elapsed}s${skipMsg}${pruneMsg}）`);
  }

  // 记录运行历史（持久化到 localStorage）
  const nodesNow = useWorkflowStore.getState().nodes;
  const status: RunRecord['status'] =
    failed.size > 0 ? 'error' : signal.aborted ? 'aborted' : 'success';

  // 成本聚合：按模型归类，便于「性价比」分析
  const byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }> = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalDuration = 0;
  let cacheHitTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let replyTokens = 0;
  for (const r of costLog) {
    totalDuration += r.durationMs;
    if (!r.usage) continue;
    const prompt = r.usage.promptTokens ?? 0;
    const completion = r.usage.completionTokens ?? 0;
    totalPrompt += prompt;
    totalCompletion += completion;
    cacheHitTokens += r.usage.cachedPromptTokens ?? 0;
    cacheWriteTokens += r.usage.writtenPromptTokens ?? 0;
    reasoningTokens += r.usage.reasoningTokens ?? 0;
    replyTokens += r.usage.replyTokens ?? completion;
    const m = (byModel[r.model] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
    m.promptTokens += prompt;
    m.completionTokens += completion;
    m.calls += 1;
  }
  const cacheMissTokens = Math.max(0, totalPrompt - cacheHitTokens - cacheWriteTokens);
  const hasCost = costLog.length > 0;

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
      cost: costByNode.get(n.id) ?? null,
    })),
    cost: hasCost
      ? {
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: totalCompletion,
          totalTokens: totalPrompt + totalCompletion,
          totalDurationMs: totalDuration,
          cache: {
            hitTokens: cacheHitTokens,
            missTokens: cacheMissTokens,
            writeTokens: cacheWriteTokens,
          },
          output: {
            reasoningTokens,
            replyTokens,
          },
          byModel,
          records: costLog,
        }
      : null,
  };
  useWorkflowStore.getState().pushRunHistory(rec);

  // 非循环工作流 + 正常跑完（无失败、未被手动停止）：将「运行指针」回退到第一个节点，
  // 使「开始」键可立刻跑下一个任务。循环工作流（hasLoop=true）依赖上一轮输出作为下一轮输入，
  // 指针不回退；失败 / 手动停止需用户介入，也不回退。
  const finishedClean = !hasLoop && failed.size === 0 && !signal.aborted;
  if (finishedClean) {
    const firstId = stages[0]?.[0] ?? nodes[0]?.id;
    if (firstId && firstId !== store.selectedNodeId) {
      store.setSelected(firstId, store.activeWfId);
    }
    store.addLog('info', '工作流已就绪，运行指针已回到首个节点，可直接开始下一个任务');
  }

  // 只有「最新且未被停止」的代次才允许复位 running / 清进度；
  // 过期协程（被 stopWorkflow 抢占）静默退出，绝不回写 store 干扰新运行。
  if (myRun === activeRunId && myRun === currentRunId) {
    store.setRunning(false);
  }
  useWorkflowStore.getState().setRunProgress({ active: false });
  currentAbort = null;
  syncDebugRun();
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

/** 沿任意边从 from 出发能否到达 target（用于检测 loopGate 的 control 回环） */
function isReachable(from: string, target: string, edges: FlowEdge[]): boolean {
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === target) return true;
    for (const e of edges) {
      if (e.source === cur && !seen.has(e.target)) {
        seen.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return false;
}

/**
 * 收集从 start 出发、能绕回 gateId（未经过 gateId 自身）的可达节点集合，
 * 即「循环体」——这些节点在每轮迭代中需强制重算。
 */
function collectReachable(start: string, gateId: string, edges: FlowEdge[], out: Set<string>): void {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === gateId) continue; // 不把 gate 本身算进 body
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.add(cur);
    for (const e of edges) {
      if (e.source === cur && e.target !== gateId) queue.push(e.target);
    }
  }
}

/** 把一条成本记录累加进节点级用量统计，返回新的统计对象（不改动入参） */
function accumulateUsage(prev: NodeUsageStat | undefined, rec: CostRecord): NodeUsageStat {
  const base: NodeUsageStat = prev ?? {
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    writtenPromptTokens: 0,
    reasoningTokens: 0,
    replyTokens: 0,
    llmDurationMs: 0,
    models: [],
  };
  const u = rec.usage;
  const prompt = u?.promptTokens ?? 0;
  const completion = u?.completionTokens ?? 0;
  return {
    calls: base.calls + 1,
    failedCalls: base.failedCalls + (rec.ok ? 0 : 1),
    promptTokens: base.promptTokens + prompt,
    completionTokens: base.completionTokens + completion,
    totalTokens: base.totalTokens + (u?.totalTokens ?? prompt + completion),
    cachedPromptTokens: base.cachedPromptTokens + (u?.cachedPromptTokens ?? 0),
    writtenPromptTokens: base.writtenPromptTokens + (u?.writtenPromptTokens ?? 0),
    reasoningTokens: base.reasoningTokens + (u?.reasoningTokens ?? 0),
    replyTokens: base.replyTokens + (u?.replyTokens ?? completion),
    llmDurationMs: base.llmDurationMs + (rec.durationMs ?? 0),
    models:
      rec.model && !base.models.includes(rec.model)
        ? [...base.models, rec.model]
        : base.models,
  };
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
  costLog: CostRecord[],
  costByNode: Map<string, CostRecord[]>,
  extraVars?: Record<string, number>,
  onGate?: (id: string, handles: string[]) => void,
  skipFailed?: boolean,
  isIncremental?: boolean,
  myRun?: number,
): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = nodeById.get(id);
  if (!node || signal.aborted) return;

  // 子图展开出来的虚拟节点在画布上并不存在，把它的状态回写到承载它的 subgraph.ref 节点上，
  // 这样用户能在画布上看到子图整体的运行/失败状态。
  const owner = ownerRefId(id);
  const setStatus: typeof store.setNodeStatus = (nid, status, patch) =>
    store.setNodeStatus(owner ?? nid, status, patch);

  /**
   * 记录一条成本，并把节点级 token 用量实时回写到画布节点上，
   * 这样运行过程中把鼠标放到节点上就能看到它自己的实时消耗。
   */
  const trackCost = (rec: CostRecord) => {
    costLog.push(rec);
    const arr = costByNode.get(rec.nodeId) ?? [];
    arr.push(rec);
    costByNode.set(rec.nodeId, arr);

    const target = owner ?? rec.nodeId;
    const wf = useWorkflowStore.getState();
    const cur = wf.nodes.find((n) => n.id === target);
    if (!cur) return;
    wf.setNodeStatus(target, cur.data.status, {
      usage: accumulateUsage(cur.data.usage, rec),
    });
    // 同步成本账本到 store，供 Companion 浮窗实时读取（共享同一数组引用）
    useWorkflowStore.getState().setCostLog(costLog);
  };

  const incoming = edges.filter((e) => e.target === id);

  // 上游失败传染：直接标记失败，不执行（其下游会因 failed 集合被继续传染）
  const upstreamFailed = incoming.some((e) => failed.has(e.source));
  if (upstreamFailed) {
    failed.add(id);
    branchState.set(id, new Set());
    setStatus(id, 'error', {
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
    setStatus(id, 'error', {
      error: `节点类型 ${node.data.typeId} 缺失（可能来自未加载的插件）`,
    });
    return;
  }

  // 增量模式下被跳过的节点：上游输出已被预填，直接复用，不执行也不改写状态
  // 注意：全量运行（!isIncremental）时 dirtySet 为空、shouldRun 全部为 false，
  // 但全量运行意图是执行所有节点，因此只在增量模式才走此跳过路径。
  if (isIncremental && !shouldRun && !forced) {
    setStatus(id, node.data.status === 'cached' ? 'cached' : (node.data.status ?? 'idle'));
    return;
  }

  // 分支剪枝：若所有入边都来自「分支节点且未被激活」的分支，则整条子图跳过
  if (incoming.length > 0) {
    const allBlocked = incoming.every((e) => {
      const s = branchState.get(e.source);
      // 未登记（普通节点缺省）= 全激活；已登记且不含该 handle = 屏蔽
      return s !== undefined && !s.has(e.sourceHandle ?? undefined);
    });
    if (allBlocked) {
      // 区分「条件不成立剪枝」与「上游失败」：
      // 失败模式下（skipFailed）若仅因上游失败而阻断，则不剪枝自身、以空输入继续尝试
      const upstreamAllFailed =
        skipFailed && incoming.length > 0 && incoming.every((e) => failed.has(e.source));
      if (upstreamAllFailed) {
        store.addLog(
          'info',
          `「${node.data.label}」上游有失败节点，按「跳过失败继续」策略仍尝试执行`,
        );
        // 不 return：继续执行（下方 collectInputs 会用空上游输出）
      } else {
        branchState.set(id, new Set()); // 被剪枝：其下游也一并剪枝
        setStatus(id, 'skipped', { startedAt: null, durationMs: null });
        return;
      }
    }
  }

  // 裁剪：stopAfter 节点的下游不再执行（其本身已执行完毕）
  if (cutSet.has(id)) {
    branchState.set(id, new Set());
    setStatus(id, 'skipped', { startedAt: null, durationMs: null });
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
      setStatus(id, 'cached', {
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
      const channel = getChannel(useWorkflowStore.getState().llmChannel);
      // 并发限流 + 限流重试（指数退避），仅对 LLM 调用生效
      const release = await limiter.acquire(signal);
      const callStart = performance.now();
      let ok = true;
      let errMsg: string | undefined;
      try {
        const resp = await withRetry(
          () =>
            channel.chat({
              agent: effective,
              messages,
              signal,
              onToken,
            }),
          {
            retries: MAX_RETRIES,
            baseDelay: RETRY_BASE_MS,
            signal,
            onRetry: (msg, delay, attempt) =>
              store.addLog(
                'info',
                `「${node.data.label}」网络有点忙，正在第 ${attempt} 次重试…（稍等约 ${(delay / 1000).toFixed(1)} 秒）`,
              ),
          },
        );
        // 成本遥测：记录本次调用的 token 用量与耗时
        const rec: CostRecord = {
          nodeId: id,
          nodeLabel: node.data.label,
          agentId,
          model: effective.model,
          usage: resp.usage,
          durationMs: Math.round(performance.now() - callStart),
          at: new Date().toISOString(),
          ok: true,
        };
        trackCost(rec);
        return resp.text;
      } catch (err) {
        ok = false;
        errMsg = err instanceof Error ? err.message : String(err);
        const rec: CostRecord = {
          nodeId: id,
          nodeLabel: node.data.label,
          agentId,
          model: effective.model,
          durationMs: Math.round(performance.now() - callStart),
          at: new Date().toISOString(),
          ok: false,
          error: errMsg,
        };
        trackCost(rec);
        throw err;
      } finally {
        release();
      }
    },
    // 成本账本引用 + 上报回调（供 Auditor 节点读取与未来外部接入）
    costLog,
    reportCost: (rec) => trackCost(rec),
    setPartial: (key, value) => {
      const target = owner ?? id;
      const cur =
        useWorkflowStore.getState().nodes.find((n) => n.id === target)?.data.outputs ?? {};
      setStatus(id, 'running', {
        outputs: { ...cur, [key]: value },
      });
    },
    setBranches: (handles) => {
      branchesTaken = handles;
      // 把分支结果回报给执行引擎（loopGate 迭代判断用）
      if (node.data.typeId === 'flow.loopGate') onGate?.(id, handles);
    },
    storage: scopedStorage(def.pluginId ?? 'core'),
    // 变量：基础(extraVars) < 项目级 < 工作流级（后者覆盖前者同名项）
    vars: {
      ...(extraVars ?? {}),
      ...useWorkflowStore.getState().projectVariables,
      ...useWorkflowStore.getState().variables,
    },
    // 资产：项目级库与当前工作流库合并（工作流级同名 id 覆盖项目级）
    assets: (() => {
      const st = useWorkflowStore.getState();
      const wfAssets = st.workflows[st.activeWfId ?? '']?.assets ?? [];
      const byId = new Map<string, AssetMeta>();
      for (const a of st.projectAssets) byId.set(a.id, a);
      for (const a of wfAssets) byId.set(a.id, a);
      return [...byId.values()] as never;
    })(),
    addAsset: (meta) => useWorkflowStore.getState().addAsset(meta),
    // 派发节点执行时把某输出端口的影响域(scope)写回对应的 task 连线（按 source+handle 匹配）。
    // 双写：① 直接 mutate 执行器局部 edges 数组（保证本次调度的 scope 串行化立刻生效）；
    //       ② 经 setEdges 同步全局 store（用于持久化与右侧 Inspector 展示）。
    writeOutEdgeScope: (handle, scope) => {
      for (const e of edges) {
        if (e.source === id && (e.sourceHandle ?? null) === (handle ?? null)) {
          e.data = { ...e.data, kind: e.data?.kind ?? 'task', scope };
        }
      }
      useWorkflowStore.getState().setEdges((prev) =>
        prev.map((e) =>
          e.source === id && (e.sourceHandle ?? null) === (handle ?? null)
            ? { ...e, data: { ...e.data, kind: e.data?.kind ?? 'task', scope } }
            : e,
        ),
      );
    },
  };

  // 代次守卫：若当前运行已被 stopWorkflow 抢占（代次过期），立即跳过执行，
  // 避免旧协程在节点返回后仍去调 def.execute / 改 store 状态。
  if (myRun !== currentRunId) {
    return { id, outputs: undefined as never, error: new DOMException('Run superseded', 'AbortError') };
  }

  setStatus(id, 'running');
  const isAgent = node.data.typeId.startsWith('agent.') || node.data.typeId.startsWith('ai.');
  if (isAgent) {
    store.addLog('info', `「${node.data.label}」正在让 AI 处理，请稍候…`);
  }
  const inputs = collectInputs(id, edges, outputsMap);
  const startedAt = Date.now();
  const perfStart = performance.now();
  try {
    // 单节点实时重试：仅对瞬时错误（网络/超时/限流类）重试，业务错误不重试
    const outputs = await withRetry(
      () => def.execute(inputs, node.data.params, ctx),
      {
        retries: NODE_RETRIES,
        baseDelay: NODE_RETRY_BASE_MS,
        signal,
        // 仅瞬时类错误重试；业务错误（解析/参数/逻辑）直接抛出
        shouldRetry: (err) => isTransient(err),
        onRetry: (msg, delay, attempt) =>
          store.addLog(
            'info',
            `「${node.data.label}」节点出错，正在第 ${attempt} 次重试（稍等约 ${(delay / 1000).toFixed(1)} 秒）：${msg}`,
          ),
      },
    );
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
    setStatus(id, 'success', {
      outputs: outputs ?? {},
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
    });
    if (stopAfter.has(id)) addDownstreamToCut(id, edges, cutSet);
  } catch (err) {
    // 插件/节点异常隔离：捕获并标记失败，不影响主应用
    const message = err instanceof Error ? err.message : String(err);
    failed.add(id);
    if (skipFailed) {
      // 跳过失败模式：失败节点不屏蔽下游，使下游仍能以空上游输出继续尝试
      branchState.set(id, new Set(def.outputs.map((o) => o.id)));
    } else {
      branchState.set(id, new Set()); // 失败节点视为屏蔽下游
    }
    setStatus(id, 'error', {
      error: message,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
    });
    store.addLog('error', `「${node.data.label}」这一步出错了：${message}`);
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

/**
 * 失败续跑（L1 可靠执行）：从上一轮失败（error 状态）的节点处继续。
 * 已成功的节点复用既有结果不动；仅失败节点及其下游被重算。
 * 用法：工作流跑挂后，修好问题节点 → 点「继续运行」即可断点续传。
 */
export async function resumeRun(): Promise<void> {
  const store = useWorkflowStore.getState();
  if (store.running) return;
  const errored = store.nodes.filter((n) => n.data.status === 'error');
  if (errored.length === 0) {
    store.addLog('info', '没有失败的节点，无需续跑');
    return;
  }
  store.addLog('info', `从断点续跑：重算 ${errored.length} 个失败节点及其下游`);
  await runWorkflow({ incremental: true, retryFailed: true });
}

