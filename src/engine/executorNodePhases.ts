import type { CostRecord } from '../types/agent';
import type { ExecContext, NodeDefinition } from '../types/node';
import type { FlowEdge, FlowNode } from '../types/graph';
import { scopedStorage, isTauri } from '../platform/env';
import { useWorkflowStore } from '../store/workflowStore';
import { withRetry } from './rateLimiter';
import type { Semaphore } from './rateLimiter';
import { computeDownstream, resolveNodeExecutionMode } from './graphAlgo';
import { decideNodeExecution } from './nodeExecutionPolicy';
import { handleNodeFailure, handleNodeSuccess } from './nodeResultHandler';
import type { ExecutionRuntime } from './runtime';
import type { ExperienceSink } from '../agents/experienceSink';
import { emitNode, type EventBus } from './runEvents';
import { requestIntervention } from './intervention';
import { getRunResources } from './runResources';
import { cacheKey, composeCacheScope, getCached, getCachedBranches, setCached } from './nodeCache';
import { collectInputs, accumulateUsage } from './executorHelpers';
import { resolveActiveWorkflowWorkspaceDir } from '../store/workflowRegistryState';
import { createNodeSandbox } from './nodeSandboxAdapter';
import { createNodeLlmAdapter } from './nodeLlmAdapter';
import { createNodeContextAdapter } from './nodeContextAdapter';
import { applyCapability, isTransient } from './executorHelpers';
import type { ExecutionCoordinator } from './executionCoordinator';

const NODE_RETRIES = 2;
const NODE_RETRY_BASE_MS = 1500;

export type NodeEventKind = Parameters<typeof emitNode>[1];
export type NodeEventPayload = Parameters<typeof emitNode>[4];
export type NodeDecision = ReturnType<typeof decideNodeExecution>;
export type SetNodeStatus = ExecutionRuntime['setNodeStatus'];
export type NodeSandbox = ReturnType<typeof createNodeSandbox>;
export type GetCurrentRunId = ExecutionCoordinator['getCurrentRunId'];
export type ScheduleRunCheckpoint = (wfId: string, runId: number, startedWall: number, force?: boolean) => void;

export interface ExecuteNodeArgs {
  id: string;
  graph: {
    nodeById: Map<string, FlowNode>;
    edges: FlowEdge[];
    outputsMap: Map<string, Record<string, unknown>>;
    branchState: Map<string, Set<string | undefined>>;
    failed: Set<string>;
    cutSet: Set<string>;
    stopAfter: Set<string>;
  };
  control: {
    sink: ExperienceSink | null;
    signal: AbortSignal;
    limiter: Semaphore;
    shouldRun: boolean;
    forced: boolean;
    onGate?: (id: string, handles: string[]) => void;
    skipFailed?: boolean;
    isIncremental?: boolean;
    myRun?: number;
    wfId?: string;
  };
  retry: { maxRetries: number; baseDelayMs: number };
  costs: { costLog: CostRecord[]; costByNode: Map<string, CostRecord[]> };
  variables: { extraVars?: Record<string, number> };
  sandbox: {
    isolatedIds?: Set<string>;
    enabled?: boolean;
    mode?: 'copy' | 'gitworktree';
  };
  runtime?: ExecutionRuntime;
}

/**
 * 阶段 1：按策略决策执行副作用。
 * 8 个终态分支各自「落状态 + 发事件」后返回 false；'execute' 返回 true 让调用方继续执行路径。
 * 分支顺序与副作用与拆分前逐行一致。
 */
export interface NodeDecisionInput {
  policy: NodeDecision;
  id: string;
  node: FlowNode;
  def: NodeDefinition | undefined;
  failed: Set<string>;
  branchState: Map<string, Set<string | undefined>>;
  outputsMap: Map<string, Record<string, unknown>>;
  stopAfter: Set<string>;
  edges: FlowEdge[];
  cutSet: Set<string>;
  setStatus: SetNodeStatus;
  emit: (kind: NodeEventKind, payload: NodeEventPayload) => void;
  countSkip: () => void;
}

export function applyNodeDecision({
  policy,
  id,
  node,
  def,
  failed,
  branchState,
  outputsMap,
  stopAfter,
  edges,
  cutSet,
  setStatus,
  emit,
  countSkip,
}: NodeDecisionInput): boolean {
  switch (policy.kind) {
    case 'upstream-failed':
      failed.add(id);
      branchState.set(id, new Set());
      setStatus(id, 'error', { error: '上游节点失败，已跳过', startedAt: null, durationMs: null });
      emit('node.skipped', {
        reason: 'upstream-failed',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return false;
    case 'missing-def':
      failed.add(id);
      branchState.set(id, new Set());
      setStatus(id, 'error', { error: `节点类型 ${policy.typeId} 缺失（可能来自未加载的插件）` });
      emit('node.skipped', {
        reason: 'missing-def',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return false;
    case 'bypass': {
      const out = policy.outputs;
      outputsMap.set(id, out);
      branchState.set(id, new Set((def?.outputs ?? []).filter((o) => o.id in out).map((o) => o.id)));
      setStatus(id, 'bypassed', { outputs: out, startedAt: null, durationMs: null });
      return false;
    }
    case 'mute':
      outputsMap.set(id, {});
      branchState.set(id, new Set());
      setStatus(id, 'muted', { startedAt: null, durationMs: null });
      return false;
    case 'incremental-skip':
      if (policy.branches !== undefined) {
        branchState.set(id, new Set(policy.branches));
      }
      setStatus(id, policy.prevStatus === 'cached' ? 'cached' : policy.prevStatus ?? 'idle');
      emit('node.skipped', {
        reason: 'incremental-skip',
        status: policy.prevStatus,
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return false;
    case 'pruned':
      branchState.set(id, new Set()); // 被剪枝：其下游也一并剪枝
      setStatus(id, 'skipped', { startedAt: null, durationMs: null });
      emit('node.skipped', {
        reason: 'pruned',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return false;
    case 'cut':
      branchState.set(id, new Set());
      setStatus(id, 'skipped', { startedAt: null, durationMs: null });
      emit('node.skipped', {
        reason: 'cut',
        label: node.data.label,
        typeId: node.data.typeId,
      });
      return false;
    case 'cached': {
      const cached = policy.outputs;
      outputsMap.set(id, cached);
      const activeBranches = policy.branches ?? (def?.outputs ?? []).map((o) => o.id);
      branchState.set(id, new Set(activeBranches));
      countSkip();
      setStatus(id, 'cached', { outputs: cached, startedAt: null, durationMs: null });
      emit('node.completed', {
        status: 'cached',
        label: node.data.label,
        typeId: node.data.typeId,
        outputs: cached,
      });
      if (stopAfter.has(id)) for (const d of computeDownstream(id, edges)) cutSet.add(d);
      return false;
    }
    case 'execute':
      return true; // 继续执行路径
  }
}

/** 阶段 2：沙箱、LLM/上下文适配器与 ExecContext 组装（含按能力等级裁剪）。 */
export interface NodeExecutionContextInput {
  id: string;
  node: FlowNode;
  def: NodeDefinition;
  owner: string | null;
  targetWfId: string;
  targetRunId: number;
  myRun?: number;
  nodeWorkspaceDir: string | null;
  incoming: FlowEdge[];
  edges: FlowEdge[];
  sandboxEnabled?: boolean;
  sandboxMode?: 'copy' | 'gitworktree';
  extraVars?: Record<string, number>;
  R: ExecutionRuntime;
  runBus: EventBus;
  signal: AbortSignal;
  limiter: Semaphore;
  sink: ExperienceSink | null;
  costLog: CostRecord[];
  maxRetries: number;
  retryBaseMs: number;
  getCurrentRunId: GetCurrentRunId;
  onSnapshot: ScheduleRunCheckpoint;
  onGate?: (id: string, handles: string[]) => void;
  setStatus: SetNodeStatus;
  trackCost: (rec: CostRecord) => void;
}

export interface NodeExecutionContext {
  ctx: ExecContext;
  sandbox: NodeSandbox;
  getBranchesTaken: () => string[] | undefined;
}

/** 沙箱 + 节点级 storage/vars + LLM 适配器（阶段 2 的第一半）。 */
function createNodeSandboxAndLlm({
  id, node, def, targetWfId, targetRunId, myRun, nodeWorkspaceDir, incoming,
  sandboxEnabled, extraVars, R, runBus, signal, limiter, sink, maxRetries, retryBaseMs, trackCost,
}: NodeExecutionContextInput, getCtx: () => ExecContext | null) {
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
    nodeCtx: { wfId: targetWfId, runId: targetRunId },
    runBus,
    signal,
    limiter,
    maxRetries,
    retryBaseMs,
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
    // 与拆分前一致：工具句柄直接引用最终 ctx（此处经 holder 迟绑定，ctx 在节点执行前必然就绪）
    getTools: () => {
      const current = getCtx();
      if (!current) throw new Error('节点上下文尚未就绪：getTools 在 ctx 组装完成前被调用');
      return { vars: current.vars, storage: current.storage, sandbox: current.sandbox };
    },
    logInfo: (message) => R.addLog('info', message),
    logWarn: (message) => R.addLog('warn', message),
    logError: (message) => R.addLog('error', message),
    recordCost: trackCost,
  });

  return { sandbox, nodeStorage, nodeVars, llm };
}

/** 上下文适配器 + ExecContext 组装 + 能力裁剪（阶段 2 的第二半）。 */
export function buildNodeExecutionContext(input: NodeExecutionContextInput): NodeExecutionContext {
  const {
    id, node, def, owner, targetWfId, targetRunId, myRun, incoming, edges, signal,
    sandboxMode, costLog, getCurrentRunId, onSnapshot, onGate, setStatus, trackCost, R,
  } = input;
  // ctx 迟绑定 holder：llm adapter 的 getTools 在执行期读取最终 ctx（与拆分前的闭包捕获等价）
  const ctxHolder: { current: ExecContext | null } = { current: null };
  const { sandbox, nodeStorage, nodeVars, llm } = createNodeSandboxAndLlm(input, () => ctxHolder.current);

  let branchesTaken: string[] | undefined;
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
    getCurrentRunId: (wfId) => getCurrentRunId(wfId),
    scheduleRunCheckpoint: onSnapshot,
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
  ctxHolder.current = ctx;

  return { ctx, getBranchesTaken: () => branchesTaken, sandbox };
}

/** 阶段 3：代次守卫 → running/事件/日志 → 带重试执行 → 成功/失败收尾。 */
export interface NodeRunInput {
  id: string;
  node: FlowNode;
  def: NodeDefinition;
  ctx: ExecContext;
  targetWfId: string;
  targetRunId: number;
  myRun?: number;
  signal: AbortSignal;
  R: ExecutionRuntime;
  emit: (kind: NodeEventKind, payload: NodeEventPayload) => void;
  setStatus: SetNodeStatus;
  getBranchesTaken: () => string[] | undefined;
  inputs: Record<string, unknown>;
  edges: FlowEdge[];
  outputsMap: Map<string, Record<string, unknown>>;
  branchState: Map<string, Set<string | undefined>>;
  failed: Set<string>;
  cutSet: Set<string>;
  stopAfter: Set<string>;
  cacheScope: string;
  skipFailed?: boolean;
  getCurrentRunId: GetCurrentRunId;
  onSnapshot: ScheduleRunCheckpoint;
}

export async function runNodeWithRetry({
  id,
  node,
  def,
  ctx,
  targetWfId,
  targetRunId,
  myRun,
  signal,
  R,
  emit,
  setStatus,
  getBranchesTaken,
  inputs,
  edges,
  outputsMap,
  branchState,
  failed,
  cutSet,
  stopAfter,
  cacheScope,
  skipFailed,
  getCurrentRunId,
  onSnapshot,
}: NodeRunInput): Promise<void> {
  // 代次守卫：若当前运行已被 stopWorkflow 抢占（代次过期），立即跳过执行，
  // 避免旧协程在节点返回后仍去调 def.execute / 改 store 状态。
  if (myRun !== getCurrentRunId(targetWfId)) {
    return;
  }

  setStatus(id, 'running');
  emit('node.started', {
    label: node.data.label,
    typeId: node.data.typeId,
  });
  const isAgent = node.data.typeId.startsWith('agent.') || node.data.typeId.startsWith('ai.');
  if (isAgent) {
    R.addLog('info', `「${node.data.label}」正在让 AI 处理，请稍候…`);
  }
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
    if (signal.aborted || targetRunId !== getCurrentRunId(targetWfId)) {
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
      branchesTaken: getBranchesTaken(),
      stopAfter,
      cache: { key: cacheKey, set: setCached },
      outputMap: { set: (nid, o) => outputsMap.set(nid, o) },
      branchState: { set: (nid, handles) => branchState.set(nid, handles) },
      h: {
        setStatus: (s, patch) => setStatus(id, s, patch),
        emit: (kind, payload) => emit(kind, payload),
        onSnapshot: () => onSnapshot(targetWfId, targetRunId, Date.now()),
        onCut: () => {
          for (const d of computeDownstream(id, edges)) cutSet.add(d);
        },
        onErrorLog: () => {},
      },
    });
  } catch (err) {
    if (signal.aborted || targetRunId !== getCurrentRunId(targetWfId)) {
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
        emit: (kind, payload) => emit(kind, payload),
        onSnapshot: () => onSnapshot(targetWfId, targetRunId, Date.now()),
        onCut: () => {},
        onErrorLog: (m) => R.addLog('error', m),
      },
    });
  }
}

/**
 * 成本记账回调：把一条成本写入运行账本与节点账本，并把节点级 token 用量实时回写到画布节点，
 * 同时同步账本引用到 store 供 Companion 浮窗读取。行为与拆分前逐行一致。
 */
export function createTrackCost({
  R,
  wfId,
  targetWfId,
  owner,
  costLog,
  costByNode,
}: {
  R: ExecutionRuntime;
  wfId?: string;
  targetWfId: string;
  owner: string | null;
  costLog: CostRecord[];
  costByNode: Map<string, CostRecord[]>;
}): (rec: CostRecord) => void {
  return (rec) => {
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
}

/** 前置路径判定 + 决策解析（纯函数组合）：返回决策与后续阶段需要的 workspace/cache 指纹。 */
export interface NodePolicyInput {
  id: string;
  targetWfId: string;
  node: FlowNode;
  def: NodeDefinition;
  incoming: FlowEdge[];
  edges: FlowEdge[];
  outputsMap: Map<string, Record<string, unknown>>;
  branchState: Map<string, Set<string | undefined>>;
  cutSet: Set<string>;
  failed: Set<string>;
  isIncremental?: boolean;
  shouldRun: boolean;
  forced: boolean;
  skipFailed?: boolean;
  isolatedIds?: Set<string>;
}

export interface NodePolicyResolution {
  policy: NodeDecision;
  nodeWorkspaceDir: string | null;
  cacheScope: string;
}

export function resolveNodePolicy({
  id,
  targetWfId,
  node,
  def,
  incoming,
  edges,
  outputsMap,
  branchState,
  cutSet,
  failed,
  isIncremental,
  shouldRun,
  forced,
  skipFailed,
  isolatedIds,
}: NodePolicyInput): NodePolicyResolution {
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
  return { policy, nodeWorkspaceDir, cacheScope };
}

export { NODE_RETRIES, NODE_RETRY_BASE_MS };
