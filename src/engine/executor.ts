import type { CostRecord } from '../types/agent';
import type { FlowNode } from '../types/graph';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { isTauri } from '../platform/env';
import { Semaphore } from './rateLimiter';
import { ownerRefId } from './subgraph';
import { shouldContinueLoop } from './graphAlgo';
import { compileExecutionPlan } from './executionKernel';
import { ExecutionCoordinator } from './executionCoordinator';
import { runStage } from './runScheduler';
import { prepareLoopRound, loopLogMessages } from './runLoop';
import { createStoreRuntime } from './runtime';
import { ExperienceSink } from '../agents/experienceSink';
import { derivePolicy, type RunContext } from './runContext';
import { emitNode, emitRun, getRunBus } from './runEvents';
import { buildRunningCheckpoint } from './checkpoint';
import { attachEventLog, getEventPersistenceMode } from './eventLog';
import { finalizeRun } from './runFinalizer';
import { cancelInterventionsForRun } from './intervention';
import { createRunResources, cleanupRun } from './runResources';
import {
  beginRun,
  clearCache,
  composeCacheScope,
  countSkip,
  strike,
} from './nodeCache';
// 单节点执行的三段式阶段函数（决策副作用 / 上下文组装 / 带重试执行）已抽到 executorNodePhases.ts
import {
  applyNodeDecision,
  buildNodeExecutionContext,
  createTrackCost,
  resolveNodePolicy,
  runNodeWithRetry,
  type ExecuteNodeArgs,
} from './executorNodePhases';
export type { ExecuteNodeArgs } from './executorNodePhases';
import type { RunOptions, RunResult } from './runTypes';
export type { RunOptions, RunResult } from './runTypes';

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
// 常量已随单节点执行阶段函数迁至 executorNodePhases.ts（NODE_RETRIES / NODE_RETRY_BASE_MS）

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
          executeNode({
            id,
            graph: { nodeById, edges, outputsMap, branchState, failed, cutSet, stopAfter },
            control: {
              sink,
              signal,
              limiter,
              shouldRun: dirtySet.has(id),
              forced: force.has(id),
              onGate: (gid, handles) => { gateTaken.set(gid, handles); },
              skipFailed: opts.skipFailed,
              isIncremental: !!opts.incremental,
              myRun,
              wfId,
            },
            retry: { maxRetries: MAX_RETRIES, baseDelayMs: RETRY_BASE_MS },
            costs: { costLog, costByNode },
            variables: { extraVars: { ...loopVarsState } },
            sandbox: { isolatedIds, enabled: !!opts.sandbox, mode: opts.sandboxMode },
            runtime: rt,
          }),
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


async function executeNode(args: ExecuteNodeArgs): Promise<void> {
  const {
    id,
    graph: { nodeById, edges, outputsMap, branchState, failed, cutSet, stopAfter },
    control: { sink, signal, limiter, shouldRun, forced, onGate, skipFailed, isIncremental, myRun, wfId },
    retry: { maxRetries: MAX_RETRIES, baseDelayMs: RETRY_BASE_MS },
    costs: { costLog, costByNode },
    variables: { extraVars },
    sandbox: { isolatedIds, enabled: sandboxEnabled, mode: sandboxMode },
    runtime: rt,
  } = args;
  const store = useWorkflowStore.getState();
  const node = nodeById.get(id);
  if (!node || signal.aborted) return;
  const targetWfId = wfId ?? store.activeWfId;
  const targetRunId = myRun ?? executionCoordinator.getCurrentRunId(targetWfId);
  // A3：节点级事件统一从全局单例总线发出（携带 wfId + runId + nodeId 三元组）。
  const runBus = getRunBus();
  const nodeCtx = { wfId: targetWfId, runId: targetRunId };
  const emit = (kind: Parameters<typeof emitNode>[1], payload: Parameters<typeof emitNode>[4]) =>
    emitNode(runBus, kind, nodeCtx, id, payload);
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
  const trackCost = createTrackCost({ R, wfId, targetWfId, owner, costLog, costByNode });

  const incoming = edges.filter((e) => e.target === id);

  const def = useRegistryStore.getState().defs[node.data.typeId];

  // 前置路径判定 + 决策解析（executorNodePhases.resolveNodePolicy）：纯函数组合，
  // 输出「执行 / 跳过 / 复用缓存 / 失败」决策与缓存指纹，副作用在阶段 1 统一执行。
  const { policy, nodeWorkspaceDir, cacheScope } = resolveNodePolicy({
    id, targetWfId, node, def, incoming, edges, outputsMap, branchState, cutSet, failed,
    isIncremental, shouldRun, forced, skipFailed, isolatedIds,
  });

  // 三个阶段函数共享的节点级作用域（节点/运行目标/运行时/写出口/代次守卫）
  const nodePhases = {
    id, node, def, owner, targetWfId, targetRunId, myRun, signal, R, emit, setStatus,
    edges, outputsMap, branchState, failed, cutSet, stopAfter,
    getCurrentRunId: (runWfId: string) => executionCoordinator.getCurrentRunId(runWfId),
    onSnapshot: scheduleRunCheckpoint,
  };

  // 阶段 1：按决策执行副作用；终态分支返回 false（不直接进后续沙箱/执行路径）
  if (!applyNodeDecision({ ...nodePhases, policy, countSkip })) return;

  // 阶段 2：沙箱 + LLM/上下文适配器 + ExecContext（含按能力等级裁剪）
  const { ctx, getBranchesTaken } = buildNodeExecutionContext({
    ...nodePhases,
    incoming, nodeWorkspaceDir, sandboxEnabled, sandboxMode, extraVars, runBus, limiter, sink,
    costLog, maxRetries: MAX_RETRIES, retryBaseMs: RETRY_BASE_MS, onGate, trackCost,
  });

  // 阶段 3：代次守卫 → running/事件/日志 → 带重试执行 → 成功/失败收尾
  await runNodeWithRetry({
    ...nodePhases, ctx, getBranchesTaken, cacheScope, skipFailed,
    inputs: collectInputs(id, edges, outputsMap),
  });
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

