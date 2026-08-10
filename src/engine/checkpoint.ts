/**
 * checkpoint.ts — 可恢复执行：运行检查点（Checkpoint）的构建与回填（Codex 规划阶段 C）。
 *
 * 背景：`retryFailed`（失败续跑）依赖内存态节点 data.status === 'error'，一旦应用关闭/
 * 项目切换，这些运行态即丢失，「从断点续跑」跨会话不可用。本模块把「最近一次运行的
 * 节点级结果」固化为检查点（Checkpoint），随项目落盘；打开项目后用户可「从检查点恢复」，
 * 把成功节点的 outputs 回填画布（复用，不重跑）、失败/中断节点标脏（续跑），实现真正的
 * 断点续传。
 *
 * 设计原则：
 * - 纯函数、零 store / React 依赖，可在 jsdom 下直接单测。
 * - 按 wfId 区分（拆分视图左右栏各自检查点）；只保留最新一次（覆盖式写）。
 * - applyCheckpoint 的恢复语义与增量执行对齐：success/cached 复用输出且不标脏，
 *   其余节点标 dirty（增量运行重跑它们及下游）。
 */
import type { FlowNode, NodeStatus, RunRecord } from '../types';

/** 单个节点的检查点快照（仅运行期关心字段，不含画布瞬态）。 */
export interface CheckpointNode {
  status: NodeStatus;
  outputs: Record<string, unknown> | null;
  error?: string;
  startedAt?: string;
  durationMs?: number;
}

/** 一次运行的检查点（按 wfId 覆盖式存储 latest，另保留多版本历史）。 */
export interface RunCheckpoint {
  wfId: string;
  runId: number;
  /** 本次运行终态（success / error / aborted / running——running 为运行中节流快照） */
  status: 'success' | 'error' | 'aborted' | 'running';
  startedAt: number;
  endedAt: number;
  /** 节点 id → 节点级结果 */
  nodes: Record<string, CheckpointNode>;
}

/** 由 RunRecord（运行历史）转成检查点：历史记录已含全部节点结果，可直接复用。
 * 兜底用途：某 wfId 无检查点但历史里有该工作流记录时，用最新历史重建。
 * RunRecord 无 runId 字段，统一记 0（仅用于展示）。 */
export function fromRunRecord(rec: RunRecord, wfId: string): RunCheckpoint {
  const nodes: Record<string, CheckpointNode> = {};
  for (const n of rec.nodes ?? []) {
    nodes[n.id] = {
      status: n.status,
      outputs: n.outputs,
      error: n.error ?? undefined,
      startedAt: n.startedAt ?? undefined,
      durationMs: n.durationMs ?? undefined,
    };
  }
  return {
    wfId,
    runId: 0,
    status: rec.status,
    startedAt: new Date(rec.startedAt).getTime(),
    endedAt: new Date(rec.endedAt).getTime(),
    nodes,
  };
}

/** 从画布节点列表构建检查点（收尾时调用；忽略 idle 节点以减小体积）。 */
export function buildCheckpoint(
  nodes: FlowNode[],
  meta: { wfId: string; runId: number; status: RunCheckpoint['status']; startedAt: number },
): RunCheckpoint {
  const cp: Record<string, CheckpointNode> = {};
  for (const n of nodes) {
    const d = n.data;
    if (!d.status || d.status === 'idle') continue;
    cp[n.id] = {
      status: d.status,
      outputs: d.outputs ?? null,
      error: d.error ?? undefined,
      startedAt: d.startedAt ?? undefined,
      durationMs: d.durationMs ?? undefined,
    };
  }
  return {
    wfId: meta.wfId,
    runId: meta.runId,
    status: meta.status,
    startedAt: meta.startedAt,
    endedAt: Date.now(),
    nodes: cp,
  };
}

/** 检查点是否值得恢复：存在失败 / 非 idle 中断态节点（即上次没跑完）。 */
export function isRestorable(cp: RunCheckpoint | null | undefined): boolean {
  if (!cp) return false;
  if (cp.status !== 'success') return true;
  // 终态 success 但仍有 error 节点（skipFailed 场景）也可恢复续跑
  return Object.values(cp.nodes).some((n) => n.status === 'error');
}

/**
 * 把检查点回填到画布节点列表（纯映射，返回新数组）。
 * 恢复语义（对齐增量执行）：
 * - success / cached：保留 outputs，不标脏 → 增量运行复用（cacheKey 命中），不重跑
 * - error：保留 error 信息，标脏 → 续跑重试
 * - 其余状态（running / skipped / idle）：归为 idle 并标脏 → 重新执行
 */
export function applyCheckpoint(cp: RunCheckpoint, nodes: FlowNode[]): FlowNode[] {
  const snapshot = cp.nodes;
  return nodes.map((n) => {
    const c = snapshot[n.id];
    if (!c) return n; // 检查点未覆盖的节点保持原样
    if (c.status === 'success' || c.status === 'cached') {
      return {
        ...n,
        data: {
          ...n.data,
          status: c.status === 'cached' ? 'cached' : 'success',
          outputs: c.outputs ?? n.data.outputs,
          error: undefined,
          startedAt: c.startedAt,
          durationMs: c.durationMs,
          dirty: false,
        },
      };
    }
    // error / 其余：标脏待重跑
    return {
      ...n,
      data: {
        ...n.data,
        status: c.status === 'error' ? 'error' : 'idle',
        outputs: c.status === 'error' ? c.outputs ?? n.data.outputs : undefined,
        error: c.error,
        startedAt: c.startedAt,
        durationMs: c.durationMs,
        dirty: true,
      },
    };
  });
}

/** 取某 wfId 的检查点（不存在返回 null）。 */
export function pickCheckpoint(
  checkpoints: Record<string, RunCheckpoint>,
  wfId: string,
): RunCheckpoint | null {
  return checkpoints[wfId] ?? null;
}

/** 多版本历史保留上限（阶段 G2：latest + 最近 N-1 个历史版本）。 */
export const CHECKPOINT_HISTORY_MAX = 5;

/**
 * 把新检查点并入历史列表（阶段 G2 多版本保留）：
 * - 按 runId 去重（同 runId 的旧快照被新快照替换——运行中节流快照与收尾快照同 runId）；
 * - 按时间戳（endedAt）降序，保留最近 CHECKPOINT_HISTORY_MAX 条。
 * 纯函数，返回新数组。
 */
export function mergeCheckpointHistory(
  history: RunCheckpoint[] | undefined,
  cp: RunCheckpoint,
): RunCheckpoint[] {
  const withoutSameRun = (history ?? []).filter((h) => h.runId !== cp.runId);
  const merged = [...withoutSameRun, cp].sort((a, b) => b.endedAt - a.endedAt);
  return merged.slice(0, CHECKPOINT_HISTORY_MAX);
}

/** 取某 wfId 的多版本历史（返回按时间新→旧排序；不存在返回 []）。 */
export function pickCheckpointHistory(
  history: Record<string, RunCheckpoint[]> | undefined,
  wfId: string,
): RunCheckpoint[] {
  return history?.[wfId] ?? [];
}

/**
 * 运行中节流快照辅助：从画布节点构建一个 status='running' 的检查点。
 * 与收尾 buildCheckpoint 的区别：不关心终态，只记录「当前已完成/失败节点」的中间结果，
 * 供崩溃恢复时恢复最近一次已完成的节点成果。
 */
export function buildRunningCheckpoint(
  nodes: FlowNode[],
  meta: { wfId: string; runId: number; startedAt: number },
): RunCheckpoint {
  return buildCheckpoint(nodes, {
    wfId: meta.wfId,
    runId: meta.runId,
    status: 'running',
    startedAt: meta.startedAt,
  });
}
