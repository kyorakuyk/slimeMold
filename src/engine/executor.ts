import type {
  CostRecord,
  ExecContext,
  FlowEdge,
  FlowNode,
} from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { resolveActiveWorkflowWorkspaceDir } from '../store/workflowRegistryState';
import { useRegistryStore } from '../store/registryStore';
import { scopedStorage, isTauri } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';
import { ownerRefId } from './subgraph';
import {
  computeDownstream,
  resolveNodeExecutionMode,
  shouldContinueLoop,
} from './graphAlgo';
import { compileExecutionPlan } from './executionKernel';
import { ExecutionCoordinator } from './executionCoordinator';
import { runStage } from './runScheduler';
import { prepareLoopRound, loopLogMessages } from './runLoop';
import { decideNodeExecution } from './nodeExecutionPolicy';
import { handleNodeSuccess, handleNodeFailure } from './nodeResultHandler';
import { createStoreRuntime, type ExecutionRuntime } from './runtime';
import { ExperienceSink } from '../agents/experienceSink';
import { derivePolicy, type RunContext } from './runContext';
import { emitNode, emitRun, getRunBus } from './runEvents';
import { buildRunningCheckpoint } from './checkpoint';
import { attachEventLog, getEventPersistenceMode } from './eventLog';
import { finalizeRun } from './runFinalizer';
import { requestIntervention, cancelInterventionsForRun } from './intervention';
import { createRunResources, cleanupRun, getRunResources } from './runResources';
import {
  beginRun,
  cacheKey,
  clearCache,
  composeCacheScope,
  countSkip,
  getCached,
  getCachedBranches,
  setCached,
  strike,
} from './nodeCache';
import { createNodeSandbox } from './nodeSandboxAdapter';
import { createNodeLlmAdapter } from './nodeLlmAdapter';
import { createNodeContextAdapter } from './nodeContextAdapter';

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

/** 每工作流独立的运行生命周期协调器：运行准入、取消和 stale completion fencing。 */
const executionCoordinator = new ExecutionCoordinator();

/**
 * 运行代次（run generation）：每次启动 runWorkflow 自增并取走当前代次号；
 * stopWorkflow 会自增它，使仍在后台的「旧协程」在下一层边界发现自己已过期，
 * 从而静默退出、不再触碰 store 状态。
 */

/** 步骤 14：暴露当前运行代次（字符串快照），供节点发布 Artifact 时填写 runId（新鲜度判断）。 */
export function getActiveRunId(wfId?: string): number {
  const id = wfId ?? useWorkflowStore.getState().activeWfId;
  return executionCoordinator.getActiveRunId(id);
}

export function workflowRequiresDevSession(nodes: readonly FlowNode[]): boolean {
  return nodes.some((node) => node.data.typeId.startsWith('dev.'));
}

/** 把运行代次同步到 store 供状态栏诊断显示 */
function syncDebugRun(wfId: string): void {
  const snapshot = {
    current: executionCoordinator.getCurrentRunId(wfId),
    active: executionCoordinator.getActiveRunId(wfId),
  };
  useWorkflowStore.getState().setDebugRun(snapshot);
}

/* ---------------- 阶段 G2：运行中节流检查点快照 ----------------
 * 应用可能在节点执行中途被崩溃/强制关闭，收尾的终态检查点来不及写。
 * 本机制在运行关键时机（节点完成、阶段结束、接管前）以节流方式把「当前已完成节点结果」
 * 落盘为 status='running' 的快照，跨会话可从最近进度恢复。
 *
 * 节流：同一 wfId+runId 每 CHECKPOINT_THROTTLE_MS 内只落一次，避免写盘放大；
 * 但每次落盘都会更新 latest（同 runId 覆盖），收尾终态再覆盖一次并进历史。
 */
const CHECKPOINT_THROTTLE_MS = 2000;
const lastSnapshotAt = new Map<string, number>();

/** 从目标工作流当前 store 状态构建 running 检查点并落盘（默认节流；force 跳过节流，供停止等关键时机）。fire-and-forget（不阻塞调度）。 */
function scheduleRunCheckpoint(wfId: string, runId: number, startedWall: number, force = false): void {
  const now = Date.now();
  const key = `${wfId}:${runId}`;
  const last = lastSnapshotAt.get(key) ?? 0;
  if (!force && now - last < CHECKPOINT_THROTTLE_MS) return; // 节流：未到间隔直接跳过
  lastSnapshotAt.set(key, now);

  const st = useWorkflowStore.getState();
  const nodes =
    wfId === st.activeWfId ? st.nodes : (st.workflows[wfId]?.nodes ?? []);
  if (nodes.length === 0) return;
  const cp = buildRunningCheckpoint(nodes, { wfId, runId, startedAt: startedWall });
  void st.persistCheckpointSnapshot(cp).catch((e) => {
    console.warn('[scheduleRunCheckpoint] 快照落盘失败（已节流跳过，不影响运行）:', e);
  });
}

// 节点级实时重试（仅瞬时错误）：与 LLM 网络层重试互补，
// 应对 LLM 层重试耗尽后仍偶发的瞬时故障（持续 429/网关超时等）
const NODE_RETRIES = 2;
const NODE_RETRY_BASE_MS = 1500;

export function stopWorkflow(wfId?: string): void {
  const id = wfId ?? useWorkflowStore.getState().activeWfId;
  const stopped = executionCoordinator.stop(id);
  const abortedRunId = stopped.abortedRunId;
  const wf = useWorkflowStore.getState();
  wf.setRunning(false, id);
  // 阶段 G2：停止前强制落盘快照（跳过节流），保存已完成节点结果——resetStatuses 会清空节点状态
  scheduleRunCheckpoint(id, abortedRunId, Date.now(), true);
  wf.resetStatuses(id);
  wf.addLog('info', `已停止工作流运行：${id}`);
  // 阶段 D：取消该运行残留的待接管请求（防挂起泄漏）
  cancelInterventionsForRun(id, abortedRunId);
  // 运行级中止事件：立即发出（被终止的旧协程 isCurrentRun=false，不再重复发）
  emitRun(getRunBus(), 'run.aborted', { wfId: id, runId: abortedRunId }, { reason: 'user-stopped' });
  // 停止是主动收尾，协调器已推进 active/current fence。
  syncDebugRun(id);
}

/**
 * 强制重跑：清空缓存后全量重新执行当前工作流。
 * 等价于在运行入口传入 forceRerun，供菜单/快捷键直接调用。
 * force: true——若上一次运行仍在进行中，直接 abort 旧协程接管重启
 * （否则运行中调用会被并发拦截忽略）。
 */
export async function rerunWorkflow(wfId?: string): Promise<RunResult> {
  return runWorkflow({ forceRerun: true, force: true, wfId });
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
  /** 本次运行的并发上限（覆盖全局 maxConcurrency；缺省取全局值）。 */
  maxConcurrency?: number;
  /**
   * 步骤 11 阶段 C：沙箱隔离强度。
   * - `copy`（默认）：基于目录副本 `.sandbox/<runId>/<nodeId>/` 做磁盘隔离。
   * - `gitworktree`：Git Worktree 真隔离——为本次运行创建 detached worktree，Worker 在独立 git 工作树内写文件，
   *   结束统一 `git worktree remove` 清理（比 .sandbox 残留更干净、可 git 级合并）。
   *   仅在 Tauri 桌面端且当前 workspaceDir 是 git 仓库时启用；否则自动降级为 `copy` 并记日志。
   */
  sandboxMode?: 'copy' | 'gitworktree';
}

/** runWorkflow 运行结果（H3b 编排器依赖：status 判定执行成败，runId 精确对应本次运行） */
export interface RunResult {
  /** success=无失败节点；error=有失败节点；aborted=手动停止/被顶替/空图/非法图 */
  status: 'success' | 'error' | 'aborted';
  /** 本次运行代次（runFinalizer 用同一 runId 写历史/checkpoint） */
  runId: number;
  /** 失败/拦截原因（aborted/error 时有） */
  error?: string;
}

export async function runWorkflow(opts: RunOptions = {}): Promise<RunResult> {
  const wfId = opts.wfId ?? useWorkflowStore.getState().activeWfId;
  const wf = useWorkflowStore.getState();
  const graphNodesForSession = wfId === wf.activeWfId ? wf.nodes : (wf.workflows[wfId]?.nodes ?? []);
  if (isTauri && workflowRequiresDevSession(graphNodesForSession)) {
    if (!wf.projectPath) {
      const error = '包含 dev.* 节点的工作流必须先打开已保存项目';
      wf.addLog('error', error);
      return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error };
    }
    const { ensureGuiDevSession } = await import('../dev/gui');
    const session = await ensureGuiDevSession(wf.projectPath);
    if (!session) {
      const error = 'Tauri DevSession 未就绪，开发节点未执行';
      wf.addLog('error', error);
      return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error };
    }
  }
  // 解耦接缝：执行引擎的输出动作（日志/进度/历史/成本）经 ExecutionRuntime 接口，
  // 默认实现委托 store；后续可替换为测试桩或独立运行时，使 executor 不依赖具体 store。
  const rt = createStoreRuntime(wfId);
  const running = wf.runStates[wfId]?.running ?? false;
  const admission = executionCoordinator.start(wfId, { running, force: Boolean(opts.force) });
  if (admission.status === 'rejected') {
    wf.addLog('warn', '上一次运行仍在有效进行中，已忽略重复启动（如需强制重启请先停止）');
    return {
      status: 'aborted',
      runId: admission.runId,
      error: '上一次运行仍在有效进行中，已忽略重复启动',
    };
  }
  if (admission.supersededRunId !== undefined) {
    // F5：force 重启取消旧运行残留的待接管请求，避免旧协程挂在介入 Promise 上。
    cancelInterventionsForRun(wfId, admission.supersededRunId);
    wf.addLog('warn', '检测到运行态残留，已强制重启运行（忽略并发拦截）');
  }
  const myRun = admission.runId;
  syncDebugRun(wfId);
  const resources = createRunResources(wfId, myRun);
  // G4：事件日志 detach 句柄——在 try 顶部声明（finally 总可安全调用），run.created 后赋值
  let detachEventLog: () => void = () => {};
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
    return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error: '还没放任何节点' };
  }

  let plan: ReturnType<typeof compileExecutionPlan>;
  try {
    plan = compileExecutionPlan(graphNodes, graphEdges, wf.subgraphs, {
      incremental: opts.incremental,
      retryFailed: opts.retryFailed,
      forceNodes: opts.forceNodes,
      stopAfterNodes: opts.stopAfterNodes,
      isolated: opts.isolated,
      maxLoopsOverride: opts.maxLoopsOverride,
    });
  } catch (err) {
    wf.addLog('error', err instanceof Error ? err.message : String(err));
    return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error: err instanceof Error ? err.message : String(err) };
  }
  const {
    nodes,
    edges,
    stages,
    cyclic,
    loopGateIds,
    loopVarOf,
    loopBodyOf,
    hasLoop,
    force,
    dirtySet,
    stopAfter,
    isolatedIds,
    clusterPlan,
    maxRounds,
  } = plan;
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
    return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error: `节点连成了死循环（${labels}）` };
  }

  // 全量运行：清除所有脏标记（之后全部节点都视为需执行，命中缓存者跳过）
  // 增量运行：保留脏标记，仅执行脏节点及其下游
  if (!opts.incremental && !opts.retryFailed) {
    wf.clearDirty();
    for (const id of force) strike(graphNodes.find((n) => n.id === id)?.data.typeId ?? '', composeCacheScope(wfId, id));
  } else {
    for (const id of force) strike(graphNodes.find((n) => n.id === id)?.data.typeId ?? '', composeCacheScope(wfId, id));
  }

  // 强制重跑：清空全局节点缓存，使所有节点都重新执行（不复用上一轮 LLM 结果）
  if (opts.forceRerun) {
    clearCache();
    wf.addLog('info', '已清空节点结果缓存，本轮将全量重新执行（强制重跑）');
  }

  const signal = admission.signal;
  wf.setRunning(true, wfId);
  wf.resetStatuses(wfId, { preserveOutputs: Boolean(opts.incremental || opts.retryFailed) });
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
  // G4：可选脱敏事件日志——订阅总线旁路落盘（off 时零开销）。收尾 finally 中 detach。
  const eventLogMode = getEventPersistenceMode();
  const eventLogRoot = useWorkflowStore.getState().projectPath;
  if (eventLogMode !== 'off' && eventLogRoot) {
    detachEventLog = attachEventLog(getRunBus(), eventLogRoot, wfId, myRun, eventLogMode);
  }
  // 清空运行期成本账本，供 Companion 浮窗实时展示
  rt.resetUsage();
  beginRun();

  // 并发限流：同一时刻最多 maxConcurrency 个 LLM 请求在进行。
  // F8：用 runCtx.policy.maxConcurrency——它已并入 opts.maxConcurrency 的运行时覆盖
  // （RunOptions 传了则以本次运行为准），而非只取工作流全局配置。
  const limiter = new Semaphore(Math.max(1, runCtx.policy.maxConcurrency));
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
  let round = 0;
  let loopContinued = false;
  // A3：真正开始调度前发出运行开始事件（Node 级事件紧随其后）。
  emitRun(getRunBus(), 'run.started', runCtx);
  do {
    // 每轮前：循环变量注入 dirtySet/force + 清缓存（纯函数，runLoop.ts）
    prepareLoopRound({
      round,
      loopBodies: loopBodyOf,
      loopVarOf,
      nodeById,
      dirtySet,
      force,
      loopVarsState,
      strike: (nodeId, typeId) => strike(typeId, composeCacheScope(wfId, nodeId)),
    });
    // 本轮开始日志（round > 0）
    if (round > 0) {
      wf.addLog('info', `循环第 ${round + 1} 轮开始（最大 ${maxRounds} 轮）`);
    }
    for (let li = 0; li < stages.length; li++) {
      if (signal.aborted || myRun !== executionCoordinator.getCurrentRunId(wfId)) break;
      // 单层调度已抽到 runScheduler.runStage：进度事件 / 簇并发 / executeNode / fail-fast / 层快照
      await runStage({
        layer: stages[li]!,
        layerIndex: li,
        totalLayers: stages.length,
        round,
        totalRounds: maxRounds,
        clusters: clusterPlan[li],
        failed,
        signal,
        isCurrent: () => myRun === executionCoordinator.getCurrentRunId(wfId),
        failFast,
        abort: () => { admission.abort(); },
        wfId,
        runCtx,
        rt,
        scheduleCheckpoint: () => scheduleRunCheckpoint(wfId, myRun, startedWall),
        onProgress: opts.onProgress,
        // 绑定 executeNode 全部参数（含本轮循环变量与 gate 回调）
        executeNode: (id) =>
          executeNode(
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
            { ...loopVarsState },
            (gid, handles) => gateTaken.set(gid, handles),
            opts.skipFailed,
            !!opts.incremental,
            myRun,
            isolatedIds,
            !!opts.sandbox,
            opts.sandboxMode,
            wfId,
            rt,
          ),
      });
    }
    if (signal.aborted || myRun !== executionCoordinator.getCurrentRunId(wfId)) break;

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
    // 达到最大轮数提示
    for (const msg of loopLogMessages({ round, maxRounds, reachedMax })) {
      wf.addLog('info', msg);
    }
  } while (loopContinued);
  if (hasLoop && round > 1) {
    wf.addLog('info', `循环结束，共执行 ${round} 轮`);
  }

  // 收尾：状态归约 / 运行历史 / checkpoint 终态 / 成本指标 / 终态事件 / 经验复盘 / 指针回退
  // 已抽到 runFinalizer.ts（executor 拆分第一刀），此处仅传入运行上下文。
  // 返回明确结果（status + runId），供调用方（含 H3b 编排器）判定执行成败。
  const finalizeResult = await finalizeRun({
    wfId,
    myRun,
    isCurrentRun: myRun === executionCoordinator.getCurrentRunId(wfId),
    workflowName: wf.workflowName,
    nodes,
    startedWall,
    startAt,
    runCtx,
    rt,
    sink,
    signal,
    costLog,
    costByNode,
    failed,
    hasLoop,
    stages,
  });
  return finalizeResult;

  } finally {
    // 只有最新代次才允许复位 UI/Abort；资源则始终按 runId 清理自己的那一份。
    const isCurrentRun = executionCoordinator.finish(wfId, myRun);
    if (isCurrentRun) {
      const latest = useWorkflowStore.getState();
      latest.setRunning(false, wfId);
      rt.setRunProgress({ active: false }, wfId);
    }
    await cleanupRun(wfId, myRun);
    // 阶段 D：无论正常/异常结束，取消本运行残留的待接管请求（防挂起泄漏）
    cancelInterventionsForRun(wfId, myRun);
    // G4：收尾 detach 事件日志（强刷缓冲并关闭文件）
    detachEventLog();
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
  const targetRunId = myRun ?? executionCoordinator.getCurrentRunId(targetWfId);
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
  // 前置决策（nodeExecutionPolicy.ts）：合并 mode + 分支剪枝 + stopAfter 裁剪 + 缓存命中，
  // 统一输出「执行 / 跳过 / 复用缓存 / 失败」决策，副作用在此函数外统一执行。
  // ---- 缓存隔离环境指纹（细粒度化）：目标工作流的 workspace 上下文。----
  // 文件读写类节点的产物依赖工作区内容，workspace 变化时旧缓存应失效。
  const curStore = useWorkflowStore.getState();
  const targetWorkflow = targetWfId === curStore.activeWfId
    ? { workspaceDir: resolveActiveWorkflowWorkspaceDir(curStore) }
    : curStore.workflows[targetWfId];
  const nodeWorkspaceDir = targetWorkflow?.workspaceDir ?? null;
  // 细粒度缓存 scope：wfId → nodeId → workspaceDir（节点实例级隔离，杜绝同工作流内
  // 相同配置的节点实例互相串产物；workspace 指纹使环境变化自动失效）。
  const cacheScope = composeCacheScope(targetWfId, id, nodeWorkspaceDir);
  const policy = decideNodeExecution({
    id,
    node,
    def,
    incoming,
    edges,
    outputsMap,
    branchState,
    cutSet,
    skipFailed,
    mode,
    forced,
    isolated: isolatedIds?.has(id),
    cacheScope,
    cacheHooks: { collectInputs, cacheKey, getCached, getCachedBranches },
  });
  // 按决策执行副作用（不直接进后续沙箱/执行路径）
  switch (policy.kind) {
    case 'upstream-failed':
      failed.add(id);
      branchState.set(id, new Set());
      setStatus(id, 'error', { error: '上游节点失败，已跳过', startedAt: null, durationMs: null });
      emitNode(runBus, 'node.skipped', nodeCtx, id, {
        reason: 'upstream-failed',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return;
    case 'missing-def':
      failed.add(id);
      branchState.set(id, new Set());
      setStatus(id, 'error', { error: `节点类型 ${policy.typeId} 缺失（可能来自未加载的插件）` });
      emitNode(runBus, 'node.skipped', nodeCtx, id, {
        reason: 'missing-def',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return;
    case 'bypass': {
      const out = policy.outputs;
      outputsMap.set(id, out);
      branchState.set(id, new Set((def?.outputs ?? []).filter((o) => o.id in out).map((o) => o.id)));
      setStatus(id, 'bypassed', { outputs: out, startedAt: null, durationMs: null });
      return;
    }
    case 'mute':
      outputsMap.set(id, {});
      branchState.set(id, new Set());
      setStatus(id, 'muted', { startedAt: null, durationMs: null });
      return;
    case 'incremental-skip':
      if (policy.branches !== undefined) {
        branchState.set(id, new Set(policy.branches));
      }
      setStatus(id, policy.prevStatus === 'cached' ? 'cached' : policy.prevStatus ?? 'idle');
      emitNode(runBus, 'node.skipped', nodeCtx, id, {
        reason: 'incremental-skip',
        status: policy.prevStatus,
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return;
    case 'pruned':
      branchState.set(id, new Set()); // 被剪枝：其下游也一并剪枝
      setStatus(id, 'skipped', { startedAt: null, durationMs: null });
      emitNode(runBus, 'node.skipped', nodeCtx, id, {
        reason: 'pruned',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return;
    case 'cut':
      branchState.set(id, new Set());
      setStatus(id, 'skipped', { startedAt: null, durationMs: null });
      emitNode(runBus, 'node.skipped', nodeCtx, id, {
        reason: 'cut',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return;
    case 'cached': {
      const cached = policy.outputs;
      outputsMap.set(id, cached);
      const activeBranches = policy.branches ?? (def?.outputs ?? []).map((o) => o.id);
      branchState.set(id, new Set(activeBranches));
      countSkip();
      setStatus(id, 'cached', { outputs: cached, startedAt: null, durationMs: null });
      emitNode(runBus, 'node.completed', nodeCtx, id, {
        status: 'cached',
        label: node.data.label,
        typeId: node.data.typeId,
        outputs: cached,
      });
      if (stopAfter.has(id)) for (const d of computeDownstream(id, edges)) cutSet.add(d);
      return;
    }
    case 'execute':
      break; // 继续执行路径
  }

  const sandbox = createNodeSandbox({
    enabled: Boolean(sandboxEnabled),
    isTauri,
    nodeId: id,
    wfId: targetWfId,
    runId: targetRunId,
    nodeWorkspaceDir,
    incomingNodeIds: incoming.filter((e) => e.target === id).map((e) => e.source),
    getRunResources,
  });

  let branchesTaken: string[] | undefined;
  const nodeStorage = scopedStorage(`${def.pluginId ?? 'core'}:${def.typeId}:${id}`);
  const nodeState = useWorkflowStore.getState();
  const nodeVars = {
    ...(extraVars ?? {}),
    ...nodeState.projectVariables,
    ...(targetWfId === nodeState.activeWfId
      ? nodeState.variables
      : (nodeState.workflows[targetWfId]?.variables ?? {})),
  };
  const llm = createNodeLlmAdapter({
    node: {
      id,
      label: node.data.label,
      typeId: node.data.typeId,
      params: node.data.params,
    },
    targetWfId,
    targetRunId,
    myRun: myRun ?? targetRunId,
    nodeCtx,
    runBus,
    signal,
    limiter,
    maxRetries: MAX_RETRIES,
    retryBaseMs: RETRY_BASE_MS,
    sink,
    getState: () => {
      const state = useWorkflowStore.getState();
      return {
        activeWfId: state.activeWfId,
        workflowName: state.workflowName,
        workflows: state.workflows,
        agents: state.agents,
        globalAgents: state.globalAgents,
        agentRouteTable: state.agentRouteTable,
        defaultAgentId: state.defaultAgentId,
        projectId: state.projectId,
        llmChannel: state.llmChannel,
      };
    },
    getTools: () => ({ vars: ctx.vars, storage: ctx.storage, sandbox: ctx.sandbox }),
    logInfo: (message) => R.addLog('info', message),
    logWarn: (message) => R.addLog('warn', message),
    logError: (message) => R.addLog('error', message),
    recordCost: trackCost,
  });
  const contextAdapter = createNodeContextAdapter({
    nodeId: id,
    ownerId: owner,
    nodeTypeId: node.data.typeId,
    nodeLabel: node.data.label,
    targetWfId,
    targetRunId,
    myRun: myRun ?? targetRunId,
    incomingNodeIds: incoming.filter((e) => e.target === id).map((e) => e.source),
    edges,
    sandbox,
    runtime: R,
    getState: () => {
      const state = useWorkflowStore.getState();
      return {
        activeWfId: state.activeWfId,
        nodes: state.nodes,
        workflows: state.workflows,
        projectAssets: state.projectAssets,
      };
    },
    setStatus,
    onBranches: (handles) => { branchesTaken = handles; },
    onGate,
    getCurrentRunId: (wfId) => executionCoordinator.getCurrentRunId(wfId),
    scheduleRunCheckpoint,
    requestIntervention,
  });
  const ctx: ExecContext = {
    signal,
    // 当前节点 id（owner ?? id，子图虚拟节点回写用）：供沙箱插件 RPC 按节点归属路由
    nodeId: owner ?? id,
    logger: {
      info: (m) => R.addLog('info', `[${node.data.label}] ${m}`),
      error: (m) => R.addLog('error', `[${node.data.label}] ${m}`),
      warn: (m) => R.addLog('warn', `[${node.data.label}] ${m}`),
    },
    llm,
    // 成本账本引用 + 上报回调（供 Auditor 节点读取与未来外部接入）
    costLog,
    reportCost: (rec) => trackCost(rec),
    ...contextAdapter,
    storage: nodeStorage,
    vars: nodeVars,
    sandbox,
  };

  // 步骤 11 阶段 D：按节点能力等级裁剪 ctx——越权字段替换为「拒绝型」实现（保持类型完整、运行时受控）
  applyCapability(ctx, def, { sandbox: !!sandbox, sandboxMode });

  // 代次守卫：若当前运行已被 stopWorkflow 抢占（代次过期），立即跳过执行，
  // 避免旧协程在节点返回后仍去调 def.execute / 改 store 状态。
  if (myRun !== executionCoordinator.getCurrentRunId(targetWfId)) {
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
    if (signal.aborted || targetRunId !== executionCoordinator.getCurrentRunId(targetWfId)) {
      // 竞态防御：abort 时节点可能仍停在「running」（stopWorkflow 的 resetStatuses
      // 在 execute 返回前已执行，随后无后续复位）。这里把当前节点复位为 idle，
      // 避免停止后节点永久显示「正在运行」。
      setStatus(id, 'idle', { outputs: undefined, error: undefined, usage: undefined });
      return;
    }
    // 节点成功收尾（nodeResultHandler.ts）：写缓存/登记分支/状态/事件/快照/stopAfter 剪裁
    handleNodeSuccess({
      id,
      node,
      def,
      outputs: outputs ?? {},
      inputs,
      upstreamOutputs: inputs,
      cacheScope,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
      branchesTaken,
      stopAfter,
      cache: { key: cacheKey, set: setCached },
      outputMap: { set: (nid, o) => outputsMap.set(nid, o) },
      branchState: { set: (nid, handles) => branchState.set(nid, handles) },
      h: {
        setStatus: (s, patch) => setStatus(id, s, patch),
        emit: (kind, payload) => emitNode(runBus, kind, nodeCtx, id, payload),
        onSnapshot: () => scheduleRunCheckpoint(targetWfId, targetRunId, Date.now()),
        onCut: () => {
          for (const d of computeDownstream(id, edges)) cutSet.add(d);
        },
        onErrorLog: () => {},
      },
    });
  } catch (err) {
    if (signal.aborted || targetRunId !== executionCoordinator.getCurrentRunId(targetWfId)) {
      // 竞态防御（同上）：abort 路径复位节点为 idle
      setStatus(id, 'idle', { outputs: undefined, error: undefined, usage: undefined });
      return;
    }
    // 插件/节点异常隔离：捕获并标记失败（nodeResultHandler.ts）
    const message = err instanceof Error ? err.message : String(err);
    failed.add(id);
    handleNodeFailure({
      id,
      node,
      def,
      message,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.round(performance.now() - perfStart),
      skipFailed: skipFailed ?? false,
      branchState: { set: (nid, handles) => branchState.set(nid, handles) },
      h: {
        setStatus: (s, patch) => setStatus(id, s, patch),
        emit: (kind, payload) => emitNode(runBus, kind, nodeCtx, id, payload),
        onSnapshot: () => scheduleRunCheckpoint(targetWfId, targetRunId, Date.now()),
        onCut: () => {},
        onErrorLog: (m) => R.addLog('error', m),
      },
    });
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

