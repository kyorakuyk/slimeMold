/**
 * intervention.ts — 实时接管（阶段 D）：节点请求人工介入的挂起/放行注册表。
 *
 * 背景：长 LLM 任务执行中，用户可能想介入某个节点——比如审阅模型产出的中途草稿、
 * 修正方向、或直接提供结果跳过调用。本模块提供「节点挂起 → UI 接管 → 放行/取消」的
 * 事件驱动通道，与统一事件总线（runEvents）打通：节点请求介入时 emit `node.intervene`，
 * UI 订阅到后弹出接管面板；用户提交/取消经 resolve/reject 放行挂起的 Promise。
 *
 * 设计原则：
 * - 模块级单例（同一时刻一个节点至多一个 pending 请求），测试可 reset。
 * - 代次守卫：运行结束/停止时 cancelInterventionsForRun 批量取消该运行的 pending，
 *   避免旧运行残留的介入请求永远挂起（配合 executor 收尾与 stopWorkflow 调用）。
 * - 纯事件驱动，零 store 依赖；UI 只需订阅总线 + 调 resolve/reject。
 */
import type { InterventionRequest, InterventionResult } from '../types';
import { emitNode, getRunBus } from './runEvents';

/** 完整介入请求（含运行定位，UI 展示用）。 */
export interface InterveneRequest extends InterventionRequest {
  wfId: string;
  runId: number;
  nodeId: string;
  /** 节点显示名 */
  label?: string;
  typeId?: string;
}

interface PendingEntry {
  req: InterveneRequest;
  resolve: (r: InterventionResult) => void;
  reject: (e: Error) => void;
}

const pending = new Map<string, PendingEntry>();

/**
 * 节点请求人工介入：emit `node.intervene` 事件并挂起，直到
 * resolveIntervention（提交结果）或 rejectIntervention（取消）。
 */
export function requestIntervention(req: InterveneRequest): Promise<InterventionResult> {
  return new Promise<InterventionResult>((resolve, reject) => {
    const prev = pending.get(req.nodeId);
    if (prev) {
      // 同一节点已有 pending 请求（异常重入）：放行旧请求，保留新请求
      prev.reject(new Error('介入请求被新请求取代'));
    }
    pending.set(req.nodeId, { req, resolve, reject });
    emitNode(
      getRunBus(),
      'node.intervene',
      { wfId: req.wfId, runId: req.runId },
      req.nodeId,
      {
        label: req.label,
        typeId: req.typeId,
        message: req.message,
        defaultResult: req.defaultResult,
      },
    );
  });
}

/** 用户提交接管结果：放行挂起的请求。返回是否找到并放行。 */
export function resolveIntervention(nodeId: string, result: string): boolean {
  const entry = pending.get(nodeId);
  if (!entry) return false;
  pending.delete(nodeId);
  entry.resolve({ kind: 'resolved', result });
  return true;
}

/** 用户取消接管：以错误放行挂起的请求（节点 execute 会收到异常，走失败路径）。 */
export function rejectIntervention(nodeId: string, error?: string): boolean {
  const entry = pending.get(nodeId);
  if (!entry) return false;
  pending.delete(nodeId);
  entry.resolve({ kind: 'cancelled', error });
  return true;
}

/** 当前全部待接管请求（UI 查询/渲染用）。 */
export function getPendingInterventions(): InterveneRequest[] {
  return [...pending.values()].map((e) => e.req);
}

/** 是否有待接管请求。 */
export function hasPendingInterventions(): boolean {
  return pending.size > 0;
}

/**
 * 取消某运行的所有 pending 请求（运行结束/停止时调用，防挂起泄漏）。
 * 以「cancelled」正常放行（非 reject）——运行结束是正常的取消语义，
 * 节点 execute 收到 cancelled 可优雅返回，而非抛异常走失败路径。
 */
export function cancelInterventionsForRun(wfId: string, runId: number): void {
  for (const [nodeId, entry] of pending) {
    if (entry.req.wfId === wfId && entry.req.runId === runId) {
      pending.delete(nodeId);
      entry.resolve({ kind: 'cancelled', error: `运行 ${wfId}/${runId} 已结束，介入请求被取消` });
    }
  }
}

/** 测试隔离：清空全部 pending。 */
export function resetInterventions(): void {
  for (const [, entry] of pending) {
    entry.reject(new Error('介入注册表已重置（测试隔离）'));
  }
  pending.clear();
}
