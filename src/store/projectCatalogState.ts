/**
 * projectCatalogState.ts — pure catalog collection transforms.
 *
 * The helpers preserve caller-owned identity and do not perform persistence, logging or store writes.
 * Project/global agent and role facades may reuse them without importing workflowStore.
 */
import type { AgentConfig, AgentRouteEntry, AgentRouteTable, RoleTemplate } from '../types';

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

export interface ProjectAgentCatalogState {
  agents: AgentConfig[];
  defaultAgentId: string | null;
  agentRouteTable: AgentRouteTable;
}

export interface ProjectAgentStatePatch {
  agents: AgentConfig[];
  defaultAgentId: string | null;
  agentRouteTable?: AgentRouteTable;
}

export function buildUpsertAgentState(
  agents: AgentConfig[],
  agent: AgentConfig,
): { agents: AgentConfig[] } {
  return { agents: upsertById(agents, agent) };
}

export function buildRemoveAgentState(
  state: ProjectAgentCatalogState,
  agentId: string,
): ProjectAgentStatePatch {
  const { table, changed } = cleanupRouteTableForAgent(state.agentRouteTable, agentId);
  return {
    agents: state.agents.filter((agent) => agent.id !== agentId),
    defaultAgentId: state.defaultAgentId === agentId ? null : state.defaultAgentId,
    ...(changed ? { agentRouteTable: table } : {}),
  };
}

export function buildSetDefaultAgentState(
  defaultAgentId: string | null,
): { defaultAgentId: string | null } {
  return { defaultAgentId };
}

export function buildUpsertRoleState(
  roles: RoleTemplate[],
  role: RoleTemplate,
): { roles: RoleTemplate[] } {
  return { roles: upsertById(roles, role) };
}

export interface ProjectRoleRemovalState {
  roles: RoleTemplate[];
  rejected: boolean;
  message?: string;
}

export function buildRemoveRoleState(
  roles: RoleTemplate[],
  roleId: string,
): ProjectRoleRemovalState {
  const role = roles.find((candidate) => candidate.id === roleId);
  if (role?.builtin) {
    return { roles, rejected: true, message: '内置角色不可删除' };
  }
  return { roles: roles.filter((candidate) => candidate.id !== roleId), rejected: false };
}
