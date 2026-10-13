import type { CostRecord } from '../types/agent';
import type { NodeDefinition } from '../types/node';
import type { FlowEdge, FlowNode } from '../types/graph';
import { useWorkflowStore } from '../store/workflowStore';
import { resolveActiveWorkflowWorkspaceDir } from '../store/workflowRegistryState';
import { resolveNodeExecutionMode } from './graphAlgo';
import { decideNodeExecution } from './nodeExecutionPolicy';
import { cacheKey, composeCacheScope, getCached, getCachedBranches } from './nodeCache';
import { collectInputs, accumulateUsage } from './executorHelpers';
import type { ExecutionRuntime } from './runtime';
import type { NodeDecision } from './executorNodePhases';

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
