import type { CostRecord } from '../types/agent';
import type { FlowNode } from '../types/graph';
import { useWorkflowStore } from '../store/workflowStore';
import i18n from '../i18n';
import { isTauri } from '../platform/env';
import type { RunOptions, RunResult } from './runTypes';
import type { ExecutionCoordinator } from './executionCoordinator';
import type { ExecutionRuntime } from './runtime';
import { compileExecutionPlan } from './executionKernel';
import { runStage } from './runScheduler';
import { prepareLoopRound, loopLogMessages } from './runLoop';
import { shouldContinueLoop } from './graphAlgo';
import { derivePolicy, type RunContext } from './runContext';
import { emitRun, getRunBus } from './runEvents';
import { attachEventLog, getEventPersistenceMode } from './eventLog';
import { finalizeRun } from './runFinalizer';
import { cancelInterventionsForRun } from './intervention';
import { cleanupRun, createRunResources, type RunResources } from './runResources';
import { beginRun, clearCache, composeCacheScope, strike } from './nodeCache';
import { ExperienceSink } from '../agents/experienceSink';
import { Semaphore } from './rateLimiter';
import type { ExecuteNodeArgs } from './executorNodePhases';

/** 工作流 store 的运行时状态快照类型（runWorkflow 传参用） */
export type WorkflowStoreState = ReturnType<typeof useWorkflowStore.getState>;
export type ExecutionStartResult = ReturnType<ExecutionCoordinator['start']>;
/** 准入通过后的运行句柄（带 signal/abort 的那一支）。 */
export type AcceptedStart = Extract<ExecutionStartResult, { signal: AbortSignal }>;
export type ExecutionPlan = ReturnType<typeof compileExecutionPlan>;

/**
 * 运行准入：并发拦截 / 强制重启残留清理 / 运行资源登记。
 * 返回 ok:false 时调用方直接回传 result（行为与原 runWorkflow 头部一致）。
 */
export interface AdmitRunInput {
  wf: WorkflowStoreState;
  wfId: string;
  opts: RunOptions;
  coordinator: ExecutionCoordinator;
  syncDebugRun: (wfId: string) => void;
}

export type AdmitRunOutcome =
  | { ok: false; result: RunResult }
  | { ok: true; admission: AcceptedStart; myRun: number; resources: RunResources };

export function admitWorkflowRun({ wf, wfId, opts, coordinator, syncDebugRun }: AdmitRunInput): AdmitRunOutcome {
  const running = wf.runStates[wfId]?.running ?? false;
  const admission = coordinator.start(wfId, { running, force: Boolean(opts.force) });
  if (admission.status === 'rejected') {
    wf.addLog('warn', i18n.t('log.duplicateStartIgnored'));
    return {
      ok: false,
      result: {
        status: 'aborted',
        runId: admission.runId,
        error: '上一次运行仍在有效进行中，已忽略重复启动',
      },
    };
  }
  if (admission.supersededRunId !== undefined) {
    // F5：force 重启取消旧运行残留的待接管请求，避免旧协程挂在介入 Promise 上。
    cancelInterventionsForRun(wfId, admission.supersededRunId);
    wf.addLog('warn', i18n.t('log.staleRunRestarted'));
  }
  const myRun = admission.runId;
  syncDebugRun(wfId);
  const resources = createRunResources(wfId, myRun);
  return { ok: true, admission, myRun, resources };
}

/**
 * 沙箱准备：每次运行开始清空上次登记的沙箱根（避免跨运行累积误删），
 * Git Worktree 真隔离探测仅在 Tauri + workspaceDir 已知 + 显式 gitworktree 时尝试，失败降级 copy。
 */
export interface SandboxSetupInput {
  wf: WorkflowStoreState;
  wfId: string;
  myRun: number;
  opts: RunOptions;
  resources: RunResources;
}

export async function setupRunSandbox({ wf, wfId, myRun, opts, resources }: SandboxSetupInput): Promise<void> {
  if (!opts.sandbox) return;
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
          wf.addLog('info', i18n.t('log.worktreeCreated', { path: wtPath }));
        } else {
          wf.addLog('warn', i18n.t('log.worktreeCreateFailed'));
        }
      } else {
        wf.addLog('warn', i18n.t('log.worktreeNotGitRepo'));
      }
    } catch (e) {
      wf.addLog('warn', i18n.t('log.worktreeProbeError', { message: String(e) }));
    }
  }
}

/** 依赖图编译 + 空图/死循环校验；失败时返回可直接回传的 abort 结果。 */
export interface PreparePlanInput {
  wf: WorkflowStoreState;
  wfId: string;
  opts: RunOptions;
  getCurrentRunId: (wfId: string) => number;
}

export type PreparePlanOutcome =
  | { ok: false; result: RunResult }
  | { ok: true; plan: ExecutionPlan; graphNodes: FlowNode[] };

export function prepareExecutionPlan({ wf, wfId, opts, getCurrentRunId }: PreparePlanInput): PreparePlanOutcome {
  const graphNodes = wfId === wf.activeWfId ? wf.nodes : (wf.workflows[wfId]?.nodes ?? []);
  const graphEdges = wfId === wf.activeWfId ? wf.edges : (wf.workflows[wfId]?.edges ?? []);
  if (graphNodes.length === 0) {
    wf.addLog('error', i18n.t('log.emptyGraph'));
    return {
      ok: false,
      result: { status: 'aborted', runId: getCurrentRunId(wfId), error: '还没放任何节点' },
    };
  }

  let plan: ExecutionPlan;
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
    const message = err instanceof Error ? err.message : String(err);
    wf.addLog('error', message);
    return { ok: false, result: { status: 'aborted', runId: getCurrentRunId(wfId), error: message } };
  }

  const { nodes, cyclic } = plan;
  const expandedCount = nodes.length - graphNodes.length;
  if (expandedCount > 0) {
    wf.addLog('info', i18n.t('log.subgraphExpanded', { count: expandedCount }));
  }

  if (cyclic.length > 0) {
    const cycleLabels = cyclic.map((id) => nodes.find((n) => n.id === id)?.data.label ?? id);
    const displayLabels = cycleLabels.join(i18n.t('log.cycleLabelsSeparator'));
    const persistedLabels = cycleLabels.join('、');
    for (const id of cyclic) {
      wf.setNodeStatus(id, 'error', { error: '这几个节点连成了死循环，请拆掉其中一条连线' }, wfId);
    }
    wf.addLog('error', i18n.t('log.cycleLog', { labels: displayLabels }));
    return {
      ok: false,
      result: { status: 'aborted', runId: getCurrentRunId(wfId), error: `节点连成了死循环（${persistedLabels}）` },
    };
  }

  return { ok: true, plan, graphNodes };
}

/** 缓存失效：全量运行清脏标记，增量/重试失败保留；force 节点与 forceRerun 按原语义处理。 */
export interface CacheInvalidationInput {
  wf: WorkflowStoreState;
  wfId: string;
  opts: RunOptions;
  graphNodes: FlowNode[];
  force: Set<string>;
}

export function applyCacheInvalidation({ wf, wfId, opts, graphNodes, force }: CacheInvalidationInput): void {
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
    wf.addLog('info', i18n.t('log.cacheCleared'));
  }
}

/** 运行会话：运行上下文/事件/事件日志/限流器/轨迹采集器（A3 事件流的接线在此收口）。 */
export interface StartRunSessionInput {
  wf: WorkflowStoreState;
  wfId: string;
  myRun: number;
  rt: ExecutionRuntime;
  resources: RunResources;
  signal: AbortSignal;
  opts: RunOptions;
  nodeCount: number;
  onEventLogAttached: (detach: () => void) => void;
}

export interface RunSession {
  runCtx: RunContext;
  detachEventLog: () => void;
  limiter: Semaphore;
  sink: ExperienceSink;
  maxRetries: number;
  retryBaseMs: number;
}

export function startRunSession({
  wf,
  wfId,
  myRun,
  rt,
  resources,
  signal,
  opts,
  nodeCount,
  onEventLogAttached,
}: StartRunSessionInput): RunSession {
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
    nodeCount,
    mode: opts.incremental ? 'incremental' : opts.retryFailed ? 'retry-failed' : 'full',
  });
  // G4：可选脱敏事件日志——订阅总线旁路落盘（off 时零开销）。收尾 finally 中 detach。
  let detachEventLog: () => void = () => {};
  const eventLogMode = getEventPersistenceMode();
  const eventLogRoot = useWorkflowStore.getState().projectPath;
  if (eventLogMode !== 'off' && eventLogRoot) {
    detachEventLog = attachEventLog(getRunBus(), eventLogRoot, wfId, myRun, eventLogMode);
    onEventLogAttached(detachEventLog);
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

  const modeLabel = opts.incremental ? i18n.t('log.modeResume') : i18n.t('log.modeFresh');
  wf.addLog('info', i18n.t('log.runStarted', { mode: modeLabel, count: nodeCount }));

  return { runCtx, detachEventLog, limiter, sink, maxRetries: MAX_RETRIES, retryBaseMs: RETRY_BASE_MS };
}

/** 运行期状态容器：输出映射/分支状态/失败集/裁剪集/成本账本/循环门与循环变量。 */
export interface RunExecutionState {
  outputsMap: Map<string, Record<string, unknown>>;
  branchState: Map<string, Set<string | undefined>>;
  failed: Set<string>;
  cutSet: Set<string>;
  nodeById: Map<string, FlowNode>;
  startAt: number;
  startedWall: number;
  costLog: CostRecord[];
  costByNode: Map<string, CostRecord[]>;
  gateTaken: Map<string, string[]>;
  loopVarsState: Record<string, number>;
}

export interface RunStateInput {
  nodes: FlowNode[];
  dirtySet: Set<string>;
  loopGateIds: Iterable<string>;
  loopVarOf: Map<string, string>;
}

export function createRunExecutionState({ nodes, dirtySet, loopGateIds, loopVarOf }: RunStateInput): RunExecutionState {
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

  return {
    outputsMap,
    branchState,
    failed,
    cutSet,
    nodeById,
    startAt,
    startedWall,
    costLog,
    costByNode,
    gateTaken,
    loopVarsState,
  };
}

/** 轮次循环：每轮 prepareLoopRound → 逐 stage 调度（runStage）→ 回环判定。 */
export interface RunRoundsInput {
  wf: WorkflowStoreState;
  wfId: string;
  myRun: number;
  opts: RunOptions;
  plan: ExecutionPlan;
  admission: AcceptedStart;
  runCtx: RunContext;
  rt: ExecutionRuntime;
  limiter: Semaphore;
  sink: ExperienceSink;
  maxRetries: number;
  retryBaseMs: number;
  dirtySet: Set<string>;
  force: Set<string>;
  state: RunExecutionState;
  executeNode: (args: ExecuteNodeArgs) => Promise<void>;
  getCurrentRunId: (wfId: string) => number;
  scheduleCheckpoint: (wfId: string, runId: number, startedWall: number) => void;
}

export async function runLoopRounds({
  wf,
  wfId,
  myRun,
  opts,
  plan,
  admission,
  runCtx,
  rt,
  limiter,
  sink,
  maxRetries,
  retryBaseMs,
  dirtySet,
  force,
  state,
  executeNode,
  getCurrentRunId,
  scheduleCheckpoint,
}: RunRoundsInput): Promise<void> {
  const { edges, stages, loopGateIds, loopVarOf, loopBodyOf, hasLoop, stopAfter, isolatedIds, clusterPlan, maxRounds } = plan;
  const { outputsMap, branchState, failed, cutSet, nodeById, costLog, costByNode, gateTaken, loopVarsState, startedWall } = state;
  const signal = admission.signal;
  const failFast = wf.failFast;

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
      wf.addLog('info', i18n.t('log.loopRoundStart', { round: round + 1, max: maxRounds }));
    }
    for (let li = 0; li < stages.length; li++) {
      if (signal.aborted || myRun !== getCurrentRunId(wfId)) break;
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
        isCurrent: () => myRun === getCurrentRunId(wfId),
        failFast,
        abort: () => { admission.abort(); },
        wfId,
        runCtx,
        rt,
        scheduleCheckpoint: () => scheduleCheckpoint(wfId, myRun, startedWall),
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
            retry: { maxRetries, baseDelayMs: retryBaseMs },
            costs: { costLog, costByNode },
            variables: { extraVars: { ...loopVarsState } },
            sandbox: { isolatedIds, enabled: !!opts.sandbox, mode: opts.sandboxMode },
            runtime: rt,
          }),
      });
    }
    if (signal.aborted || myRun !== getCurrentRunId(wfId)) break;

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
    wf.addLog('info', i18n.t('log.loopFinished', { round }));
  }
}

/** 收尾：状态归约 / 运行历史 / checkpoint 终态 / 成本指标 / 终态事件 / 经验复盘 / 指针回退。 */
export interface FinalizeRunInput {
  wf: WorkflowStoreState;
  wfId: string;
  myRun: number;
  rt: ExecutionRuntime;
  sink: ExperienceSink;
  runCtx: RunContext;
  plan: ExecutionPlan;
  state: RunExecutionState;
  isCurrentRun: boolean;
}

export async function finalizeWorkflowRun({
  wf,
  wfId,
  myRun,
  rt,
  sink,
  runCtx,
  plan,
  state,
  isCurrentRun,
}: FinalizeRunInput): Promise<RunResult> {
  return finalizeRun({
    wfId,
    myRun,
    isCurrentRun,
    workflowName: wf.workflowName,
    nodes: plan.nodes,
    startedWall: state.startedWall,
    startAt: state.startAt,
    runCtx,
    rt,
    sink,
    signal: runCtx.signal,
    costLog: state.costLog,
    costByNode: state.costByNode,
    failed: state.failed,
    hasLoop: plan.hasLoop,
    stages: plan.stages,
  });
}

/** finally 收尾：只有最新代次才允许复位 UI/Abort；资源始终按 runId 清理自己的那一份。 */
export interface FinishRunCleanupInput {
  coordinator: ExecutionCoordinator;
  wfId: string;
  myRun: number;
  rt: ExecutionRuntime;
  detachEventLog: () => void;
  syncDebugRun: (wfId: string) => void;
}

export async function finishRunCleanup({
  coordinator,
  wfId,
  myRun,
  rt,
  detachEventLog,
  syncDebugRun,
}: FinishRunCleanupInput): Promise<void> {
  const isCurrentRun = coordinator.finish(wfId, myRun);
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
