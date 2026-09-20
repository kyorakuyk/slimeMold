/** projectCatalogState direct tests. */
import { describe, it, expect } from 'vitest';
import type { AgentConfig, AgentRouteTable, RoleTemplate } from '../types';
import {
  buildRemoveAgentState,
  buildRemoveRoleState,
  buildSetDefaultAgentState,
  buildUpsertAgentState,
  buildUpsertRoleState,
  cleanupRouteTableForAgent,
  upsertById,
} from './projectCatalogState';

describe('upsertById 通用 upsert', () => {
  it('追加新项', () => {
    expect(upsertById([{ id: 'a' }], { id: 'b' })).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('替换同 id 项', () => {
    expect(upsertById([{ id: 'a', v: 1 }, { id: 'b' }], { id: 'a', v: 2 })).toEqual([
      { id: 'a', v: 2 },
      { id: 'b' },
    ]);
  });

  it('不改变原数组', () => {
    const orig = [{ id: 'a' }];
    upsertById(orig, { id: 'b' });
    expect(orig).toHaveLength(1); // 原数组不变
  });
});

describe('cleanupRouteTableForAgent 路由表清理', () => {
  it('agentId 命中且无 fallback → 整体移除该类别项并标记变更', () => {
    const table: AgentRouteTable = { ui: { agentId: 'agentA' } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.ui).toBeUndefined(); // agentId 置空后无 fallback → 整体移除
  });

  it('agentId 命中但有 fallback → 保留该项、agentId 置空', () => {
    const table: AgentRouteTable = { ui: { agentId: 'agentA', fallback: ['b'] } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.ui?.agentId).toBe('');
    expect(t.ui?.fallback).toEqual(['b']);
  });

  it('fallback 命中 → 从数组剔除', () => {
    const table: AgentRouteTable = { logic: { agentId: 'x', fallback: ['agentB', 'agentA'] } };
    const { table: t } = cleanupRouteTableForAgent(table, 'agentA');
    expect(t.logic?.fallback).toEqual(['agentB']);
  });

  it('无任何引用 → 整体移除该类别项', () => {
    const table: AgentRouteTable = { docs: { agentId: 'agentA', fallback: [] } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(true);
    expect(t.docs).toBeUndefined();
  });

  it('未引用该 agent → 不变更', () => {
    const table: AgentRouteTable = { ui: { agentId: 'other' } };
    const { table: t, changed } = cleanupRouteTableForAgent(table, 'agentA');
    expect(changed).toBe(false);
    expect(t.ui?.agentId).toBe('other');
    expect(Object.keys(t)).toEqual(['ui']);
  });
});

describe('project catalog mutation transforms', () => {
  const agent = { id: 'agent-a', name: 'A' } as unknown as AgentConfig;
  const replacement = { id: 'agent-a', name: 'A2' } as unknown as AgentConfig;
  const role = { id: 'role-a', name: 'Role A', builtin: false } as unknown as RoleTemplate;

  it('preserves upsert identity and order for agents and roles', () => {
    const agents = [agent];
    const roles = [role];
    expect(buildUpsertAgentState(agents, replacement).agents).toEqual([replacement]);
    expect(buildUpsertRoleState(roles, role).roles).toEqual([role]);
    expect(buildUpsertRoleState(roles, role).roles).not.toBe(roles);
    expect(buildUpsertAgentState([], agent).agents).toEqual([agent]);
  });

  it('removes an agent and clears default and route references', () => {
    const routeTable: AgentRouteTable = {
      ui: { agentId: 'agent-a', fallback: ['agent-b'] },
      docs: { agentId: 'agent-b', fallback: ['agent-a'] },
    };
    const result = buildRemoveAgentState({
      agents: [agent], defaultAgentId: 'agent-a', agentRouteTable: routeTable,
    }, 'agent-a');
    expect(result.agents).toEqual([]);
    expect(result.defaultAgentId).toBeNull();
    expect(result.agentRouteTable).toEqual({
      ui: { agentId: '', fallback: ['agent-b'] },
      docs: { agentId: 'agent-b', fallback: [] },
    });
    expect(routeTable.ui?.agentId).toBe('agent-a');
  });

  it('preserves route-table write omission when no route reference changes', () => {
    const routeTable: AgentRouteTable = { ui: { agentId: 'other' } };
    const result = buildRemoveAgentState({
      agents: [agent], defaultAgentId: 'other', agentRouteTable: routeTable,
    }, 'agent-a');
    expect(result.defaultAgentId).toBe('other');
    expect(result.agentRouteTable).toBeUndefined();
  });

  it('returns an explicit default-agent patch', () => {
    expect(buildSetDefaultAgentState('agent-a')).toEqual({ defaultAgentId: 'agent-a' });
  });

  it('rejects builtin role deletion with the original log message', () => {
    const builtin = { id: 'builtin', name: 'Builtin', builtin: true } as unknown as RoleTemplate;
    const result = buildRemoveRoleState([builtin], 'builtin');
    expect(result.rejected).toBe(true);
    expect(result.message).toBe('内置角色不可删除');
    expect(result.roles[0]).toBe(builtin);
  });

  it('removes custom roles without changing the source list', () => {
    const roles = [role];
    const result = buildRemoveRoleState(roles, 'role-a');
    expect(result.rejected).toBe(false);
    expect(result.roles).toEqual([]);
    expect(roles).toEqual([role]);
  });
});
