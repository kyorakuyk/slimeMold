/**
 * workflowState.test.ts — G5 门面化：状态转换纯逻辑单测。
 *
 * 覆盖：upsertById（按 id 更新/追加）、cleanupRouteTableForAgent（删除 agent 后路由表清理）。
 */
import { describe, it, expect } from 'vitest';
import type { AgentRouteTable } from '../types';
import { cleanupRouteTableForAgent, upsertById } from './workflowState';

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
