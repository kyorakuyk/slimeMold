import type { FlowNode } from '../types/graph';
import { useWorkflowStore } from '../store/workflowStore';
import i18n from '../i18n';
import { useRegistryStore } from '../store/registryStore';
import { isTauri } from '../platform/env';
import { ownerRefId } from './subgraph';
import { ExecutionCoordinator } from './executionCoordinator';
import { createStoreRuntime } from './runtime';
import { emitNode, emitRun, getRunBus } from './runEvents';
import { buildRunningCheckpoint } from './checkpoint';
import { countSkip } from './nodeCache';
import { cancelInterventionsForRun } from './intervention';
// runWorkflow 的阶段函数（准入 / 沙箱 / 计划 / 会话 / 状态 / 轮次 / 收尾）已抽到 runWorkflowPhases.ts
import {
  admitWorkflowRun,
  applyCacheInvalidation,
  createRunExecutionState,
  finalizeWorkflowRun,
  finishRunCleanup,
  prepareExecutionPlan,
  runLoopRounds,
  setupRunSandbox,
  startRunSession,
} from './runWorkflowPhases';
// 单节点执行的三段式阶段函数（决策副作用 / 上下文组装 / 带重试执行）已抽到 executorNodePhases.ts
import {
  applyNodeDecision,
  buildNodeExecutionContext,
  runNodeWithRetry,
  type ExecuteNodeArgs,
} from './executorNodePhases';
// 前置决策解析与成本记账回调（executorNodePolicy.ts）
import { createTrackCost, resolveNodePolicy } from './executorNodePolicy';
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

// 单节点操作的错误文案：该字符串会随运行结果/节点状态持久化到项目，按区域本地化会改变已存溯源，
// 因此保持常量形态（不进 i18n），并在 src/i18n/uiChineseLiterals.test.ts 登记为已记录的例外。
const ERR_NODE_MISSING = '节点不存在';

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
  wf.addLog('info', i18n.t('log.runStopped', { id }));
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
      wf.addLog('error', i18n.t('log.devSessionNeedsProject'));
      return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error };
    }
    const { ensureGuiDevSession } = await import('../dev/gui');
    const session = await ensureGuiDevSession(wf.projectPath);
    if (!session) {
      const error = 'Tauri DevSession 未就绪，开发节点未执行';
      wf.addLog('error', i18n.t('log.devSessionNotReady'));
      return { status: 'aborted', runId: executionCoordinator.getCurrentRunId(wfId), error };
    }
  }
  // 解耦接缝：执行引擎的输出动作（日志/进度/历史/成本）经 ExecutionRuntime 接口，
  // 默认实现委托 store；后续可替换为测试桩或独立运行时，使 executor 不依赖具体 store。
  const rt = createStoreRuntime(wfId);
  // 准入（runWorkflowPhases.admitWorkflowRun）：并发拦截 / 强制重启残留清理 / 运行资源登记
  const gate = admitWorkflowRun({ wf, wfId, opts, coordinator: executionCoordinator, syncDebugRun });
  if (!gate.ok) return gate.result;
  const { myRun, resources } = gate;
  // G4：事件日志 detach 句柄——在 try 顶部声明（finally 总可安全调用），run.created 后赋值
  let detachEventLog: () => void = () => {};
  try {
  // 步骤 11 阶段 C + 依赖图编译（runWorkflowPhases）：沙箱清理/Worktree 探测，空图与死循环校验。
  // 非沙箱运行必须保持准入到 startRunSession 的同步区间，不能因 await 一个空操作让位给 stop/重复准入。
  if (opts.sandbox) await setupRunSandbox({ wf, wfId, myRun, opts, resources });
  const prepared = prepareExecutionPlan({
    wf,
    wfId,
    opts,
    getCurrentRunId: (id) => executionCoordinator.getCurrentRunId(id),
  });
  if (!prepared.ok) return prepared.result;
  // 方案 A：运行态按 wfId 隔离（激活工作流复用 wf.nodes/wf.edges，非激活取 workflows[wfId]）
  const plan = prepared.plan;

  // 缓存失效（全量清脏标记 / 增量保留 / force 节点 strike / forceRerun 清空全局缓存）
  applyCacheInvalidation({ wf, wfId, opts, graphNodes: prepared.graphNodes, force: plan.force });

  // 运行会话（runWorkflowPhases.startRunSession）：运行上下文 / 事件 / 事件日志 / 限流器 / 轨迹采集器
  const session = startRunSession({
    wf,
    wfId,
    myRun,
    rt,
    resources,
    signal: gate.admission.signal,
    opts,
    nodeCount: plan.nodes.length,
    onEventLogAttached: (detach) => {
      detachEventLog = detach;
    },
  });
  detachEventLog = session.detachEventLog;

  // 运行期状态容器（runWorkflowPhases.createRunExecutionState）
  const state = createRunExecutionState({
    nodes: plan.nodes,
    dirtySet: plan.dirtySet,
    loopGateIds: plan.loopGateIds,
    loopVarOf: plan.loopVarOf,
  });

  // 轮次循环（runWorkflowPhases.runLoopRounds）：prepareLoopRound → 逐 stage runStage → 回环判定
  await runLoopRounds({
    wf, wfId, myRun, opts, plan, admission: gate.admission, runCtx: session.runCtx, rt,
    limiter: session.limiter, sink: session.sink,
    maxRetries: session.maxRetries, retryBaseMs: session.retryBaseMs,
    dirtySet: plan.dirtySet, force: plan.force, state, executeNode,
    getCurrentRunId: (id) => executionCoordinator.getCurrentRunId(id),
    scheduleCheckpoint: (id, runId, startedWall) => scheduleRunCheckpoint(id, runId, startedWall),
  });

  // 收尾：状态归约 / 运行历史 / checkpoint 终态 / 成本指标 / 终态事件 / 经验复盘 / 指针回退
  // 返回明确结果（status + runId），供调用方（含 H3b 编排器）判定执行成败。
  return await finalizeWorkflowRun({
    wf, wfId, myRun, rt, sink: session.sink, runCtx: session.runCtx, plan, state,
    isCurrentRun: myRun === executionCoordinator.getCurrentRunId(wfId),
  });

  } finally {
    // 只有最新代次才允许复位 UI/Abort；资源则始终按 runId 清理自己的那一份。
    await finishRunCleanup({
      coordinator: executionCoordinator, wfId, myRun, rt, detachEventLog, syncDebugRun,
    });
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
    getInputs: () => collectInputs(id, edges, outputsMap),
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
  if (!nodes.some((n) => n.id === id)) throw new Error(ERR_NODE_MISSING);
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
  if (!nodes.some((n) => n.id === id)) throw new Error(ERR_NODE_MISSING);
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
  if (!nodes.some((n) => n.id === id)) throw new Error(ERR_NODE_MISSING);
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
    store.addLog('info', i18n.t('log.noFailedNodes'));
    return;
  }
  store.addLog('info', i18n.t('log.resumeFromBreakpoint', { count: errored.length }));
  await runWorkflow({ incremental: true, retryFailed: true, wfId: wid });
}

