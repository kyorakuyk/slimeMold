import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { createWorkflowCatalogCommands } from './workflowCatalogCommands';
import type { WorkflowCatalogCommandState } from './workflowCatalogCommands';

function state(): WorkflowCatalogCommandState {
  return {
    agents: [{ id: 'agent-a' } as never],
    defaultAgentId: 'agent-a',
    agentRouteTable: { ui: { agentId: 'agent-a' } },
    globalAgents: [],
    roles: [{ id: 'role-builtin', builtin: true } as never],
  };
}

describe('workflow catalog commands', () => {
  it('updates project agents/roles and cleans route/default state', () => {
    let current = state();
    const setState = (patch: Partial<WorkflowCatalogCommandState>) => { current = { ...current, ...patch }; };
    const commands = createWorkflowCatalogCommands({
      getState: () => current,
      setState,
      saveGlobalAgents: vi.fn(),
      getGlobalMasterAgentId: () => null,
      clearGlobalMasterAgent: vi.fn(),
      addLog: vi.fn(),
    });

    commands.removeAgent('agent-a');
    commands.upsertRole({ id: 'role-custom' } as never);

    expect(current.agents).toEqual([]);
    expect(current.defaultAgentId).toBeNull();
    expect(current.agentRouteTable).toEqual({});
    expect(current.roles.map((role) => role.id)).toEqual(['role-builtin', 'role-custom']);
  });

  it('rejects builtin role removal and persists global-agent updates', () => {
    let current = state();
    const saveGlobalAgents = vi.fn();
    const addLog = vi.fn();
    const clearGlobalMasterAgent = vi.fn();
    const commands = createWorkflowCatalogCommands({
      getState: () => current,
      setState: (patch) => { current = { ...current, ...patch }; },
      saveGlobalAgents,
      getGlobalMasterAgentId: () => 'agent-global',
      clearGlobalMasterAgent,
      addLog,
    });

    commands.removeRole('role-builtin');
    commands.upsertGlobalAgent({ id: 'agent-global' } as never);
    commands.removeGlobalAgent('agent-global');

    expect(addLog).toHaveBeenCalledWith('error', '内置角色不可删除');
    expect(saveGlobalAgents).toHaveBeenCalledTimes(2);
    expect(clearGlobalMasterAgent).toHaveBeenCalledOnce();
  });

  it('localizes the builtin-role rejection log without changing the catalog fact', async () => {
    const originalLanguage = i18n.language;
    const current = state();
    const addLog = vi.fn();
    const commands = createWorkflowCatalogCommands({
      getState: () => current,
      setState: vi.fn(),
      saveGlobalAgents: vi.fn(),
      getGlobalMasterAgentId: () => null,
      clearGlobalMasterAgent: vi.fn(),
      addLog,
    });

    try {
      await i18n.changeLanguage('en-US');
      commands.removeRole('role-builtin');
      expect(addLog).toHaveBeenCalledWith('error', 'Built-in roles cannot be removed');
      expect(current.roles[0].builtin).toBe(true);
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
    }
  });
});
