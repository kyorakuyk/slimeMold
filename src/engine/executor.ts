import type {
  AssetMeta,
  CostRecord,
  ExecContext,
  FlowEdge,
  FlowNode,
  RunRecord,
  SandboxHandle,
} from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { getChannel } from '../agents/llmChannel';
import { runAgentLoop } from '../agents/harness';
import { scopedStorage, isTauri } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';
import { ownerRefId } from './subgraph';
import {
  computeDownstream,
  computeExecutionSet,
  isBranchPruned,
  planClustersPerStage,
  resolveNodeExecutionMode,
  shouldContinueLoop,
} from './graphAlgo';
import { buildRunPlan } from './runPlan';
import { createStoreRuntime, type ExecutionRuntime } from './runtime';
import { ExperienceSink } from '../agents/experienceSink';
import { isSelfImprove, runReview } from '../agents/reviewer';
import { readProjectText } from '../platform/env';
import { MEMORY_REL } from '../agents/memoryIo';
import { derivePolicy, type RunContext } from './runContext';
import { emitNode, emitRun, getRunBus } from './runEvents';
import { resolveAgentForRunContext } from '../agents/agentRouter';
import { buildCheckpoint } from './checkpoint';
import {
  cleanupRun,
  createRunResources,
  getRunResources,
} from './runResources';
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

/**
 * 步骤 11 阶段 D：解析节点的能力等级。
 * 显式声明 `minCapability` 优先；否则按 typeId 前缀推断默认等级：
 * - `coord.` / `flow.council` → coordinator（唯一落地权）
 * - `tool.writeFile` / `tool.file` / `tool.fs` / `fs.` → sandbox_write（隔离写）
 * - `agent.` / `ai.` / `llm` / `http` / `io.` / `tool.` → io（受限 I/O）
 * - 其余（flow/expr/if/loop/assert/merge 等）→ compute（纯计算只读）
 */
// 能力等级推导与上下文裁剪、瞬时错误判断、上游输入汇集、用量累加等纯辅助函数
// 已抽到 executorHelpers.ts，此处 import 供本文件使用，并再导出以保持既有 import 路径与单测兼容
import {
  resolveCapability,
  applyCapability,
  isTransient,
  collectInputs,
  accumulateUsage,
} from './executorHelpers';
export {
  resolveCapability,
  applyCapability,
  isTransient,
  collectInputs,
  accumulateUsage,
};

/** 每工作流独立的运行代次/中止器（拆分视图左右栏可同时运行互不打断） */
const runGens = new Map<string, { currentRunId: number; activeRunId: number; abort: AbortController | null }>();

function genFor(wfId: string): { currentRunId: number; activeRunId: number; abort: AbortController | null } {
  let g = runGens.get(wfId);
  if (!g) {
    g = { currentRunId: 0, activeRunId: 0, abort: null };
    runGens.set(wfId, g);
  }
  return g;
}

/**
 * 运行代次（run generation）：每次启动 runWorkflow 自增并取走当前代次号；
 * stopWorkflow 会自增它，使仍在后台的「旧协程」在下一层边界发现自己已过期，
 * 从而静默退出、不再触碰 store 状态。
 */

/** 步骤 14：暴露当前运行代次（字符串快照），供节点发布 Artifact 时填写 runId（新鲜度判断）。 */
export function getActiveRunId(wfId?: string): number {
  const id = wfId ?? useWorkflowStore.getState().activeWfId;
  return genFor(id).activeRunId;
}

/** 把运行代次同步到 store 供状态栏诊断显示 */
function syncDebugRun(wfId: string): void {
  const g = genFor(wfId);
  useWorkflowStore.getState().setDebugRun({ current: g.currentRunId, active: g.activeRunId });
}

// 节点级实时重试（仅瞬时错误）：与 LLM 网络层重试互补，
// 应对 LLM 层重试耗尽后仍偶发的瞬时故障（持续 429/网关超时等）
const NODE_RETRIES = 2;
const NODE_RETRY_BASE_MS = 1500;

export function stopWorkflow(wfId?: string): void {
  const id = wfId ?? useWorkflowStore.getState().activeWfId;
  const g = genFor(id);
  g.currentRunId += 1; // 让旧协程过期
  const abortedRunId = g.currentRunId - 1; // 被终止运行的代次号
  g.abort?.abort();
  g.abort = null;
  const wf = useWorkflowStore.getState();
  wf.setRunning(false, id);
  wf.resetStatuses(id);
  wf.addLog('info', `已停止工作流运行：${id}`);
  // 运行级中止事件：立即发出（被终止的旧协程 isCurrentRun=false，不再重复发）
  emitRun(getRunBus(), 'run.aborted', { wfId: id, runId: abortedRunId }, { reason: 'user-stopped' });
}

/**
 * 强制重跑：清空缓存后全量重新执行当前工作流。
 * 等价于在运行入口传入 forceRerun，供菜单/快捷键直接调用。
 */
export async function rerunWorkflow(wfId?: string): Promise<void> {
  return runWorkflow({ forceRerun: true, wfId });
}

/**
 * 运行工作流的选项（RunOptions）。
 */
export interface RunOptions {
  /** 目标工作流 id（拆分视图可独立运行；缺省取当前激活工作流） */
  wfId?: string;
  /** 增量模式：只执行脏节点及其下游（非脏节点复用已有/缓存结果） */
  incremental?: boolean;
  /** 强制重算的节点集合（重跑单节点时使用），会清除其缓存 */
  forceNodes?: string[];
  /** 执行到这些节点为止（含），其下游不再执行（标记 skipped）。用于「重跑到此节点」 */
  stopAfterNodes?: string[];
  /**
   * 单节点运行：仅 forceNodes 内的节点参与执行，且不汇聚任何上游输入（以空输入运行），
   * 下游不执行。用于孤立调试单个节点。
   */
  isolated?: boolean;
  /** 强制重启（忽略并发拦截，用于 Play 按钮检测到运行态卡死时的透传） */
  force?: boolean;
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
  /**
   * 真沙箱（步骤 11 阶段 C）：为 true 时，每个写文件的节点获得独立隔离目录
   * （workspaceDir/.sandbox/<nodeId>/），并行 Worker 互不踩踏；协调者节点
   * （coord.resolver / coord.council）拿到聚合沙箱句柄，可读取各 Worker 沙箱并 commitAll 汇总。
   * 默认 false，保持旧行为（共享工作区直写）。
   */
  sandbox?: boolean;
  /**
   * 步骤 11 阶段 C：沙箱隔离强度。
   * - `copy`（默认）：基于目录副本 `.sandbox/<runId>/<nodeId>/` 做磁盘隔离。
   * - `gitworktree`：Git Worktree 真隔离——为本次运行创建 detached worktree，Worker 在独立 git 工作树内写文件，
   *   结束统一 `git worktree remove` 清理（比 .sandbox 残留更干净、可 git 级合并）。
   *   仅在 Tauri 桌面端且当前 workspaceDir 是 git 仓库时启用；否则自动降级为 `copy` 并记日志。
   */
  sandboxMode?: 'copy' | 'gitworktree';
}

export async function runWorkflow(opts: RunOptions = {}): Promise<void> {
  const wfId = opts.wfId ?? useWorkflowStore.getState().activeWfId;
  const wf = useWorkflowStore.getState();
  // 解耦接缝：执行引擎的输出动作（日志/进度/历史/成本）经 ExecutionRuntime 接口，
  // 默认实现委托 store；后续可替换为测试桩或独立运行时，使 executor 不依赖具体 store。
  const rt = createStoreRuntime(wfId);
  const gen = genFor(wfId);
  // 若上一次运行仍有效（activeRunId 与最新代次一致，即未被停止过）才阻止并发重入；
  // 若已被 stopWorkflow 自增代次，则允许新启动（解决「刷新键后启动键失效」）。
  const running = wf.runStates[wfId]?.running ?? false;
  if (running && gen.activeRunId === gen.currentRunId) {
    if (opts.force) {
      gen.abort?.abort();
      wf.addLog('warn', '检测到运行态残留，已强制重启运行（忽略并发拦截）');
    } else {
      wf.addLog('warn', '上一次运行仍在有效进行中，已忽略重复启动（如需强制重启请先停止）');
      return;
    }
  }
  const myRun = ++gen.currentRunId; // 本次运行代次
  gen.activeRunId = myRun;
  syncDebugRun(wfId);
  const resources = createRunResources(wfId, myRun);
  let abortController: AbortController | null = null;
  try {
  // 步骤 11 阶段 C：每次运行开始清空上次登记的沙箱根，避免跨运行累积误删
  if (opts.sandbox) {
    // Git Worktree 真隔离探测：仅 Tauri + workspaceDir 已知 + 显式请求 gitworktree 时尝试
    const runWorkspaceDir = wf.workspaceDir ?? null;
    if (opts.sandboxMode === 'gitworktree' && isTauri && runWorkspaceDir) {
      try {
        const { isGitRepo, addWorktree } = await import('../platform/git');
        if (await isGitRepo(runWorkspaceDir)) {
          const branch = `slime-sandbox-${wfId}-${myRun}-${Date.now().toString(36)}`;
          const wtPath = `${runWorkspaceDir}/.slime-wt/${branch}`;
          const created = await addWorktree(runWorkspaceDir, wtPath, branch);
          if (created) {
            const wt = { cwd: runWorkspaceDir, path: wtPath, branch };
            resources.worktree = wt;
            resources.gitWorktrees = [wt];
            wf.addLog('info', `已创建 Git Worktree 强隔离沙箱：${wtPath}`);
          } else {
            wf.addLog('warn', 'Git Worktree 创建失败，降级为 copy 沙箱');
          }
        } else {
          wf.addLog('warn', '当前工作目录非 git 仓库，Git Worktree 模式降级为 copy 沙箱');
        }
      } catch (e) {
        wf.addLog('warn', `Git Worktree 探测异常，降级为 copy 沙箱：${String(e)}`);
      }
    }
  }
  const { failFast } = wf;
  // 方案 A：运行态按 wfId 隔离。激活工作流复用 s.nodes/s.edges，非激活取 workflows[wfId]
  const graphNodes = wfId === wf.activeWfId ? wf.nodes : (wf.workflows[wfId]?.nodes ?? []);
  const graphEdges = wfId === wf.activeWfId ? wf.edges : (wf.workflows[wfId]?.edges ?? []);
  if (graphNodes.length === 0) {
    wf.addLog('error', '还没放任何节点，先把节点拖到画布上吧');
    return;
  }

  let plan: ReturnType<typeof buildRunPlan>;
  try {
    plan = buildRunPlan(graphNodes, graphEdges, wf.subgraphs);
  } catch (err) {
    wf.addLog('error', err instanceof Error ? err.message : String(err));
    return;
  }
  const { nodes, edges, stages, cyclic, loopGateIds, loopVarOf, maxLoopsOf, loopBodyOf, hasLoop } = plan;
  const expandedCount = nodes.length - graphNodes.length;
  if (expandedCount > 0) {
    wf.addLog('info', `已展开子图，新增 ${expandedCount} 个内部步骤`);
  }

  if (cyclic.length > 0) {
    const labels = cyclic
      .map((id) => nodes.find((n) => n.id === id)?.data.label ?? id)
      .join('、');
    for (const id of cyclic) {
      wf.setNodeStatus(id, 'error', { error: '这几个节点连成了死循环，请拆掉其中一条连线' }, wfId);
    }
    wf.addLog('error', `有节点连成了死循环（${labels}），请拆掉其中一条连线后再运行`);
    return;
  }

  const force = new Set(opts.forceNodes ?? []);
  const stopAfter = new Set(opts.stopAfterNodes ?? []);
  const isolatedIds = opts.isolated ? new Set(opts.forceNodes ?? []) : undefined;
  // 失败续跑（L1）：把上一轮 error 节点及其全部下游标记为本次需执行集
  if (opts.retryFailed) {
    const errored = nodes.filter((n) => n.data.status === 'error').map((n) => n.id);
    for (const id of errored) {
      const downstream = computeDownstream(id, edges); // 含 errored 自身
      for (const d of downstream) force.add(d);
    }
  }
  // 全量运行：清除所有脏标记（之后全部节点都视为需执行，命中缓存者跳过）
  // 增量运行：保留脏标记，仅执行脏节点及其下游
  if (!opts.incremental && !opts.retryFailed) {
    wf.clearDirty();
    for (const id of force) strike(graphNodes.find((n) => n.id === id)?.data.typeId ?? '');
  } else {
    for (const id of force) strike(graphNodes.find((n) => n.id === id)?.data.typeId ?? '');
  }
  // 执行集（纯计算，来自 graphAlgo.computeExecutionSet）：
  //  - force 节点恒在执行集；增量模式叠加 data.dirty；子图虚拟节点一律视为需执行。
  const { dirtySet } = computeExecutionSet(nodes, { ...opts, forceNodes: [...force] });


  // 强制重跑：清空全局节点缓存，使所有节点都重新执行（不复用上一轮 LLM 结果）
  if (opts.forceRerun) {
    clearCache();
    wf.addLog('info', '已清空节点结果缓存，本轮将全量重新执行（强制重跑）');
  }

  abortController = new AbortController();
  gen.abort = abortController;
  const signal = abortController.signal;
  wf.setRunning(true, wfId);
  wf.resetStatuses(wfId);
  // A3：构建贯穿本次运行的 RunContext（A1 定型），并发出运行创建事件。
  // 供统一事件流 / JobBoard / 后续检查点持久化与 AgentRouter 共用。
  const runCtx: RunContext = {
    projectId: wf.projectId,
    wfId,
    runId: myRun,
    goal: wf.workflowName,
    signal,
    startedAt: performance.now(),
    startedWall: Date.now(),
    resources,
    policy: derivePolicy(opts, { maxConcurrency: wf.maxConcurrency ?? 3 }),
  };
  emitRun(getRunBus(), 'run.created', runCtx, {
    nodeCount: nodes.length,
    mode: opts.incremental ? 'incremental' : opts.retryFailed ? 'retry-failed' : 'full',
  });
  // 清空运行期成本账本，供 Companion 浮窗实时展示
  rt.resetUsage();
  beginRun();

  // 并发限流：同一时刻最多 maxConcurrency 个 LLM 请求在进行
  const limiter = new Semaphore(Math.max(1, wf.maxConcurrency ?? 3));
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;
  // #9/#8：轨迹采集器（供 reviewer 复盘沉淀记忆/技能），本轮运行共享一个实例
  const sink = new ExperienceSink(wf.workflowName);

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
  // 预计算每层的 scope 串行化簇划分（层结构 stages 与边 edges 在轮间稳定，无需每轮重算）
  const clusterPlan = planClustersPerStage(stages, edges);
  // A3：真正开始调度前发出运行开始事件（Node 级事件紧随其后）。
  emitRun(getRunBus(), 'run.started', runCtx);
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
      if (signal.aborted || myRun !== gen.currentRunId) break;
      // 上报调度进度（层索引 / 总层数 / 当前轮次 / 总轮次）
      const progress = {
        layer: stages.indexOf(layer) + 1,
        totalLayers: stages.length,
        round: round + 1,
        totalRounds: maxRounds,
      };
      opts.onProgress?.(progress);
      rt.setRunProgress({ active: true, ...progress }, wfId);
      // A2/A3：调度进度同样进统一事件流（JobBoard 从事件流消费，而非直接读 store）
      emitRun(getRunBus(), 'run.progress', runCtx, progress);
      // 同 stage 内节点相互独立，可并行调度（瓶颈在 LLM I/O）；
      // 控制流（control）边已保证 stage 间严格有序，循环/条件断点不破坏检测。
      // B-full 串行化：若同 stage 内多个节点通过 task 边声明了**相交的影响域(scope)**，
      // 说明它们会争用同一资源，强制把它们归到同一「串行簇」内按序执行，消解并发冲突；
      // 互不冲突的节点仍保持并行（簇间并行、簇内串行），最大化并行度。
      const clusters = clusterPlan[stages.indexOf(layer)];
      // 簇间并行；每个簇内按列表顺序串行执行（冲突节点被挤进同一簇）
      await Promise.all(
        clusters.map((cluster) =>
          (async () => {
            for (const id of cluster) {
              if (signal.aborted || myRun !== gen.currentRunId) break;
              await executeNode(
                id,
                nodeById,
                edges,
                outputsMap,
                branchState,
                failed,
                cutSet,
                stopAfter,
                sink,
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
                isolatedIds,
                !!opts.sandbox,
                opts.sandboxMode,
                wfId,
                rt,
              );
            }
          })(),
        ),
      );
      if (failFast && failed.size > 0) {
        gen.abort?.abort();
        break;
      }
      // failFast=false 且开启「跳过失败继续」：不中断，继续下一 stage
      // （失败节点的下游会在 executeNode 内判定为「跳过失败」而非剪枝）
    }
    if (signal.aborted || myRun !== gen.currentRunId) break;

    // 判断是否需要继续迭代：任一 loopGate 本轮走了 pass 分支 ⇒ 循环体被激活 ⇒ 继续
    const { loopContinued: cont, reachedMax } = shouldContinueLoop({
      hasLoop,
      loopGateIds,
      gateTaken,
      round,
      maxRounds,
    });
    loopContinued = cont;
    gateTaken.clear();
    round += 1;
    if (reachedMax) {
      wf.addLog('info', `已达到最大循环轮数 ${maxRounds}，强制结束循环`);
    }
  } while (loopContinued);
  if (hasLoop && round > 1) {
    wf.addLog('info', `循环结束，共执行 ${round} 轮`);
  }

  const store = useWorkflowStore.getState();
  // 代次守卫：被 force/stop 淘汰且新运行已启动的旧协程（myRun !== currentRunId），
  // 不再写终态日志 / 运行历史 / 触发 selfImprove，避免污染新运行的收尾。
  // 若仅是用户 stop 且未开启新运行（myRun === currentRunId 仍成立），保留 aborted 历史。
  const isCurrentRun = myRun === gen.currentRunId;
  const elapsed = ((performance.now() - startAt) / 1000).toFixed(1);
  const skipped = skippedCount();
  // 分支剪枝 / 被上游失败跳过的节点数（结束态为 'skipped'）
  const pruned = nodes.filter((n) => n.data.status === 'skipped').length;
  if (!isCurrentRun) {
    // 被淘汰的旧运行：只留一条最简日志，不写历史/复盘，避免污染新运行
    rt.addLog('warn', `旧运行已由新一次运行替代，不再记录本次收尾（用时 ${elapsed}s）`);
  } else if (signal.aborted && failed.size === 0) {
    rt.addLog('info', `已手动停止（用时 ${elapsed}s）`);
  } else if (failed.size > 0) {
    rt.addLog(
      'error',
      `有 ${failed.size} 个步骤没跑通，请检查标红的节点（用时 ${elapsed}s）`,
    );
  } else {
    const skipMsg = skipped > 0 ? `，${skipped} 步用了缓存结果` : '';
    const pruneMsg = pruned > 0 ? `，${pruned} 步因条件不成立而跳过` : '';
    rt.addLog('info', `全部完成 ✓（用时 ${elapsed}s${skipMsg}${pruneMsg}）`);
  }

  // 记录运行历史（持久化到 localStorage）——仅当前代次运行才写历史/复盘/指针回退，
  // 被 force/stop 淘汰的旧运行只保留最简日志，不污染新运行的收尾。
  if (isCurrentRun) {
    const nodesNow = nodes;
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
    rt.pushRunHistory(rec);

    // C：可恢复执行——把本次运行的节点级结果固化为检查点（覆盖式，按 wfId），
    // 随项目落盘；下次打开项目可「从断点恢复」复用成功节点输出、续跑失败节点。
    useWorkflowStore
      .getState()
      .setCheckpoint(buildCheckpoint(nodes, { wfId, runId: myRun, status, startedAt: startedWall }));

    // A3：运行级终态事件（completed / failed / aborted）统一在此发出，与历史记录状态一致。
    const finalKind: 'run.completed' | 'run.failed' | 'run.aborted' =
      status === 'error' ? 'run.failed' : status === 'aborted' ? 'run.aborted' : 'run.completed';
    emitRun(getRunBus(), finalKind, runCtx, {
      status,
      durationMs: rec.durationMs,
      nodeCount: nodes.length,
      skipped,
      pruned,
      failed: failed.size,
      elapsed: Number(elapsed),
    });

    // #8 自优化闭环：selfImprove 开启且配置了 reviewer 角色时，本轮结束后异步触发综合复盘，
    // 把轨迹沉淀为记忆（memory.md）/ 技能（subgraph 草稿）。fire-and-forget，不阻塞收尾。
    if (isSelfImprove()) {
      const reviewerAgent = useWorkflowStore.getState().agents.find((a) => a.id === 'role.reviewer');
      if (reviewerAgent) {
        sink.setOutcome(failed.size > 0 ? 'failure' : 'success');
        const root = useWorkflowStore.getState().projectPath ?? null;
        void (async () => {
          try {
            const memory = root ? (await readProjectText(root, MEMORY_REL)) ?? undefined : undefined;
            const skills = Object.values(useWorkflowStore.getState().subgraphs).map((s) => s.name);
            runReview({
              kind: '_COMBINED',
              reviewerAgent,
              context: { goal: wf.workflowName, trace: sink.toTraceText(), memory, skills },
              async: true,
              projectRoot: root,
            });
          } catch (e) {
            rt.addLog('warn', `复盘触发失败（不影响本次运行）：${e instanceof Error ? e.message : String(e)}`);
          }
        })();
      }
    }

    // 非循环工作流 + 正常跑完（无失败、未被手动停止）：将「运行指针」回退到第一个节点，
    // 使「开始」键可立刻跑下一个任务。循环工作流（hasLoop=true）依赖上一轮输出作为下一轮输入，
    // 指针不回退；失败 / 手动停止需用户介入，也不回退。
    const finishedClean = !hasLoop && failed.size === 0 && !signal.aborted;
    if (finishedClean) {
      const firstId = stages[0]?.[0] ?? nodes[0]?.id;
      if (firstId && firstId !== store.selectedNodeId) {
        store.setSelected(firstId, wfId);
      }
      rt.addLog('info', '工作流已就绪，运行指针已回到首个节点，可直接开始下一个任务');
    }
  }

  } finally {
    // 只有最新代次才允许复位 UI/Abort；资源则始终按 runId 清理自己的那一份。
    if (myRun === gen.activeRunId && myRun === gen.currentRunId) {
      const latest = useWorkflowStore.getState();
      latest.setRunning(false, wfId);
      rt.setRunProgress({ active: false }, wfId);
      if (abortController && gen.abort === abortController) gen.abort = null;
    }
    await cleanupRun(wfId, myRun);
    syncDebugRun(wfId);
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
  sink: ExperienceSink | null,
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
  isolatedIds?: Set<string>,
  sandboxEnabled?: boolean,
  sandboxMode?: 'copy' | 'gitworktree',
  wfId?: string,
  rt?: ExecutionRuntime,
): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = nodeById.get(id);
  if (!node || signal.aborted) return;
  const targetWfId = wfId ?? store.activeWfId;
  const targetRunId = myRun ?? genFor(targetWfId).currentRunId;
  const gen = genFor(targetWfId);
  // A3：节点级事件统一从全局单例总线发出（携带 wfId + runId + nodeId 三元组）。
  const runBus = getRunBus();
  const nodeCtx = { wfId: targetWfId, runId: targetRunId };
  // 解耦接缝：节点内的「只写」输出动作（状态/日志/成本/资产/边）经 rt 收口；
  // 缺省退化为直接委托 store，保证接缝接入前行为不变。
  const R = rt ?? createStoreRuntime(targetWfId);

  // 子图展开出来的虚拟节点在画布上并不存在，把它的状态回写到承载它的 subgraph.ref 节点上，
  // 这样用户能在画布上看到子图整体的运行/失败状态。
  const owner = ownerRefId(id);
  const setStatus: (nid: string, status: Parameters<typeof R.setNodeStatus>[1], patch?: Parameters<typeof R.setNodeStatus>[2]) => void =
    (nid, status, patch) => R.setNodeStatus(owner ?? nid, status, patch, wfId);

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
    const cur = (targetWfId === wf.activeWfId ? wf.nodes : (wf.workflows[targetWfId]?.nodes ?? [])).find((n) => n.id === target);
    if (!cur) return;
    R.setNodeStatus(target, cur.data.status, {
      usage: accumulateUsage(cur.data.usage, rec),
    }, wfId);
    // 同步成本账本到 store，供 Companion 浮窗实时读取（共享同一数组引用）
    R.setCostLog(costLog);
  };

  const incoming = edges.filter((e) => e.target === id);

  const def = useRegistryStore.getState().defs[node.data.typeId];

  // 前置路径判定（纯函数版）：上游失败传染 / 类型缺失 / bypass / mute / 增量跳过 / 正常执行
  const mode = resolveNodeExecutionMode({
    node,
    def,
    incoming,
    failed,
    isIncremental: Boolean(isIncremental),
    shouldRun,
    forced,
  });
  if (mode.kind === 'upstream-failed') {
    failed.add(id);
    branchState.set(id, new Set());
    setStatus(id, 'error', {
      error: '上游节点失败，已跳过',
      startedAt: null,
      durationMs: null,
    });
    emitNode(runBus, 'node.skipped', nodeCtx, id, {
      reason: 'upstream-failed',
      label: node.data.label,
      typeId: node.data.typeId,
    });
    return;
  }
  if (mode.kind === 'missing-def') {
    failed.add(id);
    branchState.set(id, new Set());
    setStatus(id, 'error', {
      error: `节点类型 ${node.data.typeId} 缺失（可能来自未加载的插件）`,
    });
    emitNode(runBus, 'node.skipped', nodeCtx, id, {
      reason: 'missing-def',
      label: node.data.label,
      typeId: node.data.typeId,
    });
    return;
  }

  // ---- 步骤 11 阶段 C：真沙箱句柄 ----
  // 每个节点一份独立隔离目录（workspaceDir/.sandbox/<nodeId>），并行 Worker 互不踩踏。
  // 协调者（coord.resolver / coord.council）拿到聚合句柄，可跨节点读取并 commitAll 汇总。
  let sandbox: SandboxHandle | undefined;
  if (sandboxEnabled) {
    const currentStore = useWorkflowStore.getState();
    const targetWorkflow = targetWfId === currentStore.activeWfId
      ? { workspaceDir: currentStore.workspaceDir }
      : currentStore.workflows[targetWfId];
    const workspaceDir = targetWorkflow?.workspaceDir ?? null;
    const inBrowser = !isTauri;

    // 主工作区根：有 workspaceDir 用其；否则惰性取 AppData 内部目录（避免同步调用 tauri API）
    const rootDir = async (): Promise<string | null> => {
      if (inBrowser) return null;
      // 步骤 11 阶段 C：Git Worktree 强隔离模式下，所有节点沙箱根指向 worktree（按 wfId）
      const resources = getRunResources(targetWfId, targetRunId);
      const wt = resources?.worktree;
      if (wt) return wt.path;
      if (workspaceDir) return workspaceDir;
      try {
        const { appDataDir } = await import('@tauri-apps/api/path');
        return `${await appDataDir()}/slime-mold/${targetWfId}`;
      } catch {
        return null;
      }
    };
    // 解析 + 登记：任何节点触达的真实根目录都登记到当前 run 的资源对象，
    // 供 runWorkflow 结束按 runId 清理其下 `.sandbox/` 残留。
    const rootDirAndTrack = async (): Promise<string | null> => {
      const base = await rootDir();
      if (base) {
        const resources = getRunResources(targetWfId, targetRunId);
        resources?.sandboxRoots.add(base);
      }
      return base;
    };

    const sandboxRoot = (nid: string, base: string): string => `${base}/.sandbox/${nid}`;

    sandbox = {
      nodeId: id,
      baseDir: null, // 真实路径惰性确定，构造期未知
      inBrowser,
      async writeFile(filename, content) {
        const base = await rootDirAndTrack();
        if (!base) return `[sandbox:${id}] ${filename}`; // 浏览器/无根：内存态
        const fs = await import('@tauri-apps/plugin-fs');
        const dir = sandboxRoot(id, base);
        await fs.mkdir(dir, { recursive: true });
        const p = `${dir}/${filename}`;
        await fs.writeTextFile(p, content);
        return p;
      },
      async readFrom(otherNodeId, filename) {
        const base = await rootDirAndTrack();
        if (!base) return null;
        const fs = await import('@tauri-apps/plugin-fs');
        const p = `${sandboxRoot(otherNodeId, base)}/${filename}`;
        try {
          return await fs.readTextFile(p);
        } catch {
          return null;
        }
      },
      async list(otherNodeId) {
        const base = await rootDirAndTrack();
        if (!base) return [];
        const fs = await import('@tauri-apps/plugin-fs');
        const dir = sandboxRoot(otherNodeId, base);
        try {
          return (await fs.readDir(dir)).map((e) => e.name).filter(Boolean) as string[];
        } catch {
          return [];
        }
      },
      async commitAll() {
        const base = await rootDirAndTrack();
        if (!base) return [];
        const fs = await import('@tauri-apps/plugin-fs');
        const src = sandboxRoot(id, base);
        const dst = base;
        await fs.mkdir(dst, { recursive: true });
        const committed: string[] = [];
        let entries: Awaited<ReturnType<typeof fs.readDir>> = [];
        try {
          entries = await fs.readDir(src);
        } catch {
          return committed;
        }
        for (const e of entries) {
          if (e.isFile) {
            const name = e.name;
            const content = await fs.readTextFile(`${src}/${name}`);
            const target = `${dst}/${name}`;
            await fs.writeTextFile(target, content);
            committed.push(target);
          }
        }
        return committed;
      },
      async commitLanes(laneIds) {
        const base = await rootDirAndTrack();
        if (!base) return [];
        const fs = await import('@tauri-apps/plugin-fs');
        await fs.mkdir(base, { recursive: true });
        const committed: string[] = [];
        for (const lane of laneIds) {
          const laneDir = sandboxRoot(lane, base);
          let files: Awaited<ReturnType<typeof fs.readDir>> = [];
          try {
            files = await fs.readDir(laneDir);
          } catch {
            continue; // 该车道无沙箱产出（例如未写文件），跳过
          }
          for (const e of files) {
            if (e.isFile) {
              const name = e.name;
              const content = await fs.readTextFile(`${laneDir}/${name}`);
              const target = `${base}/${name}`;
              await fs.writeTextFile(target, content);
              committed.push(target);
            }
          }
        }
        return committed;
      },
    };
  }

  // bypass / mute 调试开关（仿 ComfyUI 的 Ctrl+B / Ctrl+M）
  if (mode.kind === 'bypass' || mode.kind === 'mute') {
    const bypassIn = edges.filter((e) => e.target === id);
    const out: Record<string, unknown> = {};
    if (node.data.bypass) {
      // 同名端口透传：上游输入端口的值直接作为同 id 输出端口的值
      for (const e of bypassIn) {
        const inPort = def.inputs.find((i) => i.id === e.targetHandle);
        if (!inPort) continue;
        const outPort = def.outputs.find((o) => o.id === inPort.id);
        if (!outPort) continue;
        const upstreamOut = outputsMap.get(e.source);
        out[outPort.id] = upstreamOut ? upstreamOut[e.sourceHandle ?? ''] : undefined;
      }
      outputsMap.set(id, out);
      branchState.set(id, new Set(def.outputs.filter((o) => o.id in out).map((o) => o.id)));
      setStatus(id, 'bypassed', { outputs: out, startedAt: null, durationMs: null });
    } else {
      // mute：不执行，输出置空
      outputsMap.set(id, out);
      branchState.set(id, new Set());
      setStatus(id, 'muted', { startedAt: null, durationMs: null });
    }
    return;
  }

  // 增量模式下被跳过的节点：上游输出已被预填，直接复用，不执行也不改写状态
  // 注意：全量运行（!isIncremental）时 dirtySet 为空、shouldRun 全部为 false，
  // 但全量运行意图是执行所有节点，因此只在增量模式才走此跳过路径。
  if (mode.kind === 'incremental-skip') {
    setStatus(id, mode.prevStatus === 'cached' ? 'cached' : mode.prevStatus);
    emitNode(runBus, 'node.skipped', nodeCtx, id, {
      reason: 'incremental-skip',
      status: mode.prevStatus,
      label: node.data.label,
      typeId: node.data.typeId,
    });
    return;
  }

  // 分支剪枝：若所有入边都来自「分支节点且未被激活」的分支，则整条子图跳过
  if (incoming.length > 0 && isBranchPruned(incoming, branchState, skipFailed ?? false, failed)) {
    branchState.set(id, new Set()); // 被剪枝：其下游也一并剪枝
    setStatus(id, 'skipped', { startedAt: null, durationMs: null });
    emitNode(runBus, 'node.skipped', nodeCtx, id, {
      reason: 'pruned',
      label: node.data.label,
      typeId: node.data.typeId,
    });
    return;
  }

  // 裁剪：stopAfter 节点的下游不再执行（其本身已执行完毕）
  if (cutSet.has(id)) {
    branchState.set(id, new Set());
    setStatus(id, 'skipped', { startedAt: null, durationMs: null });
    emitNode(runBus, 'node.skipped', nodeCtx, id, {
      reason: 'cut',
      label: node.data.label,
      typeId: node.data.typeId,
    });
    return;
  }

  // 缓存命中判断：相同 类型+参数+上游输出 直接复用结果（forced 时已在 runWorkflow 内 strike）
  if (!forced) {
    // 单节点运行（isolated）：不汇聚任何上游，强制以空输入参与缓存键计算
    const upstreamOutputs = isolatedIds && isolatedIds.has(id) ? {} : collectInputs(id, edges, outputsMap);
    // scope=targetWfId：跨工作流隔离缓存，避免文件/资产/workspace 上下文不同的工作流互相复用产物
    const key = cacheKey(node.data.typeId, node.data.params, upstreamOutputs, targetWfId);
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
      emitNode(runBus, 'node.completed', nodeCtx, id, {
        status: 'cached',
        label: node.data.label,
        typeId: node.data.typeId,
        outputs: cached,
      });
      if (stopAfter.has(id)) for (const d of computeDownstream(id, edges)) cutSet.add(d);
      return;
    }
  }

  let branchesTaken: string[] | undefined;
  const ctx: ExecContext = {
    signal,
    logger: {
      info: (m) => R.addLog('info', `[${node.data.label}] ${m}`),
      error: (m) => R.addLog('error', `[${node.data.label}] ${m}`),
      warn: (m) => R.addLog('warn', `[${node.data.label}] ${m}`),
    },
    llm: async (agentId, messages, onToken, modelOverride, toolNames) => {
      // B：AgentRouter 运行时决策——显式 agentId 有效则直接用；
      // 缺失/失效时查项目级路由表 → fallback 链 → 默认 agent → 首个可用，逐级兜底，
      // 使节点「没绑 agent / 绑的 agent 被删」不再白白抛错，路由表运行时真正生效。
      const requestedAgentId = agentId;
      let agent = useWorkflowStore
        .getState()
        .agents.find((a) => a.id === requestedAgentId);
      if (!agent) {
        const st = useWorkflowStore.getState();
        const goal =
          targetWfId === st.activeWfId
            ? st.workflowName
            : (st.workflows[targetWfId]?.name ?? '');
        const decision = resolveAgentForRunContext(
          { agentId: requestedAgentId, typeId: node.data.typeId },
          {
            agents: st.agents,
            routeTable: st.agentRouteTable ?? {},
            defaultAgentId: st.defaultAgentId ?? null,
          },
          goal ? { goal } : null,
        );
        agent = decision.agent;
        // 路由决策进入事件流（JobBoard 忽略 node.progress，不污染看板；供历史/调试消费）
        emitNode(runBus, 'node.progress', nodeCtx, id, {
          progressKind: 'agent-route',
          requestedAgentId: requestedAgentId ?? '',
          agentId: decision.agent.id,
          reason: decision.reason,
          chain: decision.chain,
          tier: decision.tier,
        });
        R.addLog(
          'info',
          `「${node.data.label}」智能体${requestedAgentId ? ` ${requestedAgentId}` : '未指定'}不可用，AgentRouter 已路由到「${decision.agent.name}」（${decision.reason}）`,
        );
      }
      const effective = modelOverride
        ? { ...agent, model: modelOverride }
        : agent;
      // 并发限流：包裹整个 LLM 调用（含 harness 的 tool_call 多轮）
      const release = await limiter.acquire(signal);
      const callStart = performance.now();
      const recordCost = (usage: CostRecord['usage'], ok: boolean, errMsg?: string) => {
        trackCost({
          nodeId: id,
          nodeLabel: node.data.label,
          agentId: agent.id,
          model: effective.model,
          usage,
          durationMs: Math.round(performance.now() - callStart),
          at: new Date().toISOString(),
          ok,
          error: errMsg,
        });
      };
      try {
        // —— 工具多轮：走 AgentHarness（tool_call 循环由 harness 内部驱动）——
        if (toolNames && toolNames.length) {
          // 拆分 system（首条）与其余消息
          const sys = messages.find((m) => m.role === 'system');
          const userMsgs = messages.filter((m) => m.role !== 'system');
          const result = await runAgentLoop({
            agent: effective,
            userMessages: userMsgs,
            systemParts: sys ? { role: sys.content as string } : undefined,
            toolNames,
            // #7：把已合并的 (项目级 < 工作流级 < 节点级) 变量作为作用域栈注入上下文
            scopeStack: [ctx.vars],
            signal,
            modelOverride: modelOverride || undefined,
            // #9/#8：把 harness 事件桥接到本运行共享的 ExperienceSink（供 reviewer 复盘）
            events: sink
              ? (() => {
                  const se = sink.events();
                  return {
                    onThinking: se.onThinking,
                    onToolCall: se.onToolCall,
                    onOutput: (text: string, done: boolean) => {
                      se.onOutput?.(text, done);
                      if (!done && onToken) onToken(text);
                    },
                    onLog: (lv: string, m: string) => {
                      const level = lv as 'info' | 'warn' | 'error';
                      se.onLog?.(level, m);
                      R.addLog(level, m);
                    },
                  };
                })()
              : {
                  onOutput: (text: string, done: boolean) => {
                    if (!done && onToken) onToken(text);
                  },
                  onLog: (lv: string, m: string) => R.addLog(lv as 'info' | 'warn' | 'error', m),
                },
            toolCtx: { logger: ctx.logger, storage: ctx.storage, sandbox: ctx.sandbox },
          });
          recordCost(undefined, true);
          return result.text;
        }
        // —— 普通调用：保持原 channel.chat 行为（限流 + 重试 + 遥测）——
        const channel = getChannel(useWorkflowStore.getState().llmChannel);
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
            onRetry: (_msg, delay, attempt) =>
              R.addLog(
                'info',
                `「${node.data.label}」网络有点忙，正在第 ${attempt} 次重试…（稍等约 ${(delay / 1000).toFixed(1)} 秒）`,
              ),
          },
        );
        recordCost(resp.usage, true);
        return resp.text;
      } catch (err) {
        const em = err instanceof Error ? err.message : String(err);
        recordCost(undefined, false, em);
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
      const st = useWorkflowStore.getState();
      const targetNodes = targetWfId === st.activeWfId
        ? st.nodes
        : (st.workflows[targetWfId]?.nodes ?? []);
      const cur = targetNodes.find((n) => n.id === target)?.data.outputs ?? {};
      setStatus(id, 'running', {
        outputs: { ...cur, [key]: value },
      });
    },
    setBranches: (handles) => {
      branchesTaken = handles;
      // 把分支结果回报给执行引擎（loopGate 迭代判断用）
      if (node.data.typeId === 'flow.loopGate') onGate?.(id, handles);
    },
    // 存储按节点实例隔离（scope = 插件 + 类型 + 实例 id），避免同插件不同节点/同类型不同实例互相读写。
    storage: scopedStorage(`${def.pluginId ?? 'core'}:${def.typeId}:${id}`),
    // 变量：基础(extraVars) < 项目级 < 工作流级（后者覆盖前者同名项）
    vars: {
      ...(extraVars ?? {}),
      ...useWorkflowStore.getState().projectVariables,
      ...(targetWfId === useWorkflowStore.getState().activeWfId
        ? useWorkflowStore.getState().variables
        : (useWorkflowStore.getState().workflows[targetWfId]?.variables ?? {})),
    },
    // 资产：项目级库与当前工作流库合并（工作流级同名 id 覆盖项目级）
    assets: (() => {
      const st = useWorkflowStore.getState();
      const wfAssets = targetWfId === st.activeWfId
        ? st.workflows[st.activeWfId ?? '']?.assets ?? []
        : st.workflows[targetWfId]?.assets ?? [];
      const byId = new Map<string, AssetMeta>();
      for (const a of st.projectAssets) byId.set(a.id, a);
      for (const a of wfAssets) byId.set(a.id, a);
      return [...byId.values()] as never;
    })(),
    addAsset: (meta) => R.addAsset(meta),
    // 步骤 11 阶段 C：真沙箱句柄（仅 sandbox 运行模式注入，普通模式为 undefined）
    sandbox,
    // 协调者节点的上游车道 id（供 commitLanes 汇总 Worker 沙箱）
    sandboxLanes: sandbox
      ? incoming.filter((e) => e.target === id).map((e) => e.source)
      : undefined,
    // 派发节点执行时把某输出端口的影响域(scope)写回对应的 task 连线（按 source+handle 匹配）。
    // 双写：① 直接 mutate 执行器局部 edges 数组（保证本次调度的 scope 串行化立刻生效）；
    //       ② 经 setEdges 同步全局 store（用于持久化与右侧 Inspector 展示）。
    writeOutEdgeScope: (handle, scope) => {
      for (const e of edges) {
        if (e.source === id && (e.sourceHandle ?? null) === (handle ?? null)) {
          e.data = { ...e.data, kind: e.data?.kind ?? 'task', scope };
        }
      }
      R.setEdges((prev) =>
        prev.map((e) =>
          e.source === id && (e.sourceHandle ?? null) === (handle ?? null)
            ? { ...e, data: { ...e.data, kind: e.data?.kind ?? 'task', scope } }
            : e,
        ),
      );
    },
  };

  // 步骤 11 阶段 D：按节点能力等级裁剪 ctx——越权字段替换为「拒绝型」实现（保持类型完整、运行时受控）
  applyCapability(ctx, def, { sandbox: !!sandbox, sandboxMode });

  // 代次守卫：若当前运行已被 stopWorkflow 抢占（代次过期），立即跳过执行，
  // 避免旧协程在节点返回后仍去调 def.execute / 改 store 状态。
  if (myRun !== gen.currentRunId) {
    return;
  }

  setStatus(id, 'running');
  emitNode(runBus, 'node.started', nodeCtx, id, {
    label: node.data.label,
    typeId: node.data.typeId,
  });
  const isAgent = node.data.typeId.startsWith('agent.') || node.data.typeId.startsWith('ai.');
  if (isAgent) {
    R.addLog('info', `「${node.data.label}」正在让 AI 处理，请稍候…`);
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
          R.addLog(
            'info',
            `「${node.data.label}」节点出错，正在第 ${attempt} 次重试（稍等约 ${(delay / 1000).toFixed(1)} 秒）：${msg}`,
          ),
      },
    );
    if (signal.aborted || targetRunId !== gen.currentRunId) return;
    outputsMap.set(id, outputs ?? {});
    // 写入缓存：以「类型+参数+上游输出+工作流scope」为 key，下游命中时自动复用
    const key = cacheKey(node.data.typeId, node.data.params, inputs, targetWfId);
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
    emitNode(runBus, 'node.completed', nodeCtx, id, {
      status: 'success',
      label: node.data.label,
      typeId: node.data.typeId,
      outputs: outputs ?? {},
      durationMs: Math.round(performance.now() - perfStart),
    });
    if (stopAfter.has(id)) for (const d of computeDownstream(id, edges)) cutSet.add(d);
  } catch (err) {
    if (signal.aborted || targetRunId !== gen.currentRunId) return;
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
    emitNode(runBus, 'node.failed', nodeCtx, id, {
      error: message,
      label: node.data.label,
      typeId: node.data.typeId,
      durationMs: Math.round(performance.now() - perfStart),
    });
    R.addLog('error', `「${node.data.label}」这一步出错了：${message}`);
  }
}

/**
 * 重跑单个节点（及其下游）：标记该节点为脏并强制重算（清除其缓存），
 * 再以增量模式运行——等价于 ComfyUI 的「重跑该子图」。
 * 上游结果直接复用，避免重复调用。
 */
export async function retryNode(id: string, wfId?: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const wid = wfId ?? store.activeWfId;
  const nodes = wid === store.activeWfId ? store.nodes : (store.workflows[wid]?.nodes ?? []);
  if (!nodes.some((n) => n.id === id)) throw new Error('节点不存在');
  if (store.runStates[wid]?.running) return;
  store.markDirty(id);
  await runWorkflow({ incremental: true, forceNodes: [id], wfId: wid });
}

/**
 * 重跑到指定节点为止：执行该节点及其上游链（上游脏则重算、否则复用缓存），
 * 但该节点完成之后其下游不再执行（标记 skipped）。用于「中断粒度」——只跑部分子图。
 */
export async function runToNode(id: string, wfId?: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const wid = wfId ?? store.activeWfId;
  const nodes = wid === store.activeWfId ? store.nodes : (store.workflows[wid]?.nodes ?? []);
  if (!nodes.some((n) => n.id === id)) throw new Error('节点不存在');
  if (store.runStates[wid]?.running) return;
  store.markDirty(id);
  await runWorkflow({ incremental: true, forceNodes: [id], stopAfterNodes: [id], wfId: wid });
}

/**
 * 单独运行一个节点：仅执行该节点本身，不汇聚上游、也不跑下游。
 * 用于孤立调试单个节点（如单独重试一次 LLM 调用、查看其输出）。
 * 输入为空对象，节点需能处理无输入的情形。
 */
export async function runSingleNode(id: string, wfId?: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const wid = wfId ?? store.activeWfId;
  const nodes = wid === store.activeWfId ? store.nodes : (store.workflows[wid]?.nodes ?? []);
  if (!nodes.some((n) => n.id === id)) throw new Error('节点不存在');
  if (store.runStates[wid]?.running) return;
  store.markDirty(id);
  await runWorkflow({ incremental: true, forceNodes: [id], stopAfterNodes: [id], isolated: true, wfId: wid });
}

/**
 * 失败续跑（L1 可靠执行）：从上一轮失败（error 状态）的节点处继续。
 * 已成功的节点复用既有结果不动；仅失败节点及其下游被重算。
 * 用法：工作流跑挂后，修好问题节点 → 点「继续运行」即可断点续传。
 */
export async function resumeRun(wfId?: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const wid = wfId ?? store.activeWfId;
  const nodes = wid === store.activeWfId ? store.nodes : (store.workflows[wid]?.nodes ?? []);
  if (store.runStates[wid]?.running) return;
  const errored = nodes.filter((n) => n.data.status === 'error');
  if (errored.length === 0) {
    store.addLog('info', '没有失败的节点，无需续跑');
    return;
  }
  store.addLog('info', `从断点续跑：重算 ${errored.length} 个失败节点及其下游`);
  await runWorkflow({ incremental: true, retryFailed: true, wfId: wid });
}

