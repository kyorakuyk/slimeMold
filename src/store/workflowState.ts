/**
 * workflowState.ts — workflowStore 状态转换纯逻辑（G5 门面化继续）。
 *
 * 收拢「不触碰 store 单例」的纯状态转换：
 * - upsertById：通用「按 id 更新或追加」列表转换
 * - cleanupRouteTableForAgent：删除 agent 后路由表清理（agentId 命中置空、fallback 剔除、
 *   无引用项整体移除）
 *
 * 设计原则：纯函数，只依赖输入参数 + 类型；workflowStore action 负责 set/get 调度，
 * 本模块只做「给定旧状态 → 新状态」的纯计算，可独立单测。
 */
import type { AgentRouteEntry, AgentRouteTable } from '../types';

/** 按 id 更新或追加：列表中存在同 id 项则替换，否则追加。纯函数。 */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const exists = list.some((a) => a.id === item.id);
  return exists ? list.map((a) => (a.id === item.id ? item : a)) : [...list, item];
}

/**
 * 删除 agent 后清理路由表（纯函数）：
 * - agentId 命中该 id → 置空
 * - fallback 含该 id → 从数组中剔除
 * - 无任何引用（agentId 为空且无 fallback）→ 整体移除该类别项
 *
 * @returns 清理后的路由表 + 是否发生变更（供调用方决定是否写回 store）
 */
export function cleanupRouteTableForAgent(
  routeTable: AgentRouteTable,
  agentId: string,
): { table: AgentRouteTable; changed: boolean } {
  const table = { ...routeTable };
  let changed = false;
  for (const key of Object.keys(table)) {
    const item = table[key];
    if (!item) continue;
    const next: AgentRouteEntry = {
      agentId: item.agentId,
      fallback: item.fallback ? [...item.fallback] : [],
    };
    if (next.agentId === agentId) {
      next.agentId = '';
      changed = true;
    }
    if (next.fallback?.includes(agentId)) {
      next.fallback = next.fallback.filter((f) => f !== agentId);
      changed = true;
    }
    // 类别项已无任何引用（agentId 被删或为空，且无 fallback）→ 整体移除，避免留下脏配置
    if (!next.agentId && (next.fallback?.length ?? 0) === 0) {
      delete table[key];
      changed = true;
    } else {
      table[key] = next;
    }
  }
  return { table, changed };
}
