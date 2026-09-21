import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, RoleTemplate } from '../types/agent';
import type { AgentRouteTable } from '../types/dispatch';
import { useWorkflowStore } from './workflowStore';

const agent = { id: 'agent-a', name: 'A' } as unknown as AgentConfig;
const replacement = { id: 'agent-a', name: 'A2' } as unknown as AgentConfig;
const customRole = { id: 'role-a', name: 'Role A', builtin: false } as unknown as RoleTemplate;
const builtinRole = { id: 'role-builtin', name: 'Builtin', builtin: true } as unknown as RoleTemplate;

beforeEach(() => {
  useWorkflowStore.setState({
    projectId: 'project-1',
    agents: [agent],
    defaultAgentId: 'agent-a',
    roles: [customRole, builtinRole],
    agentRouteTable: {
      ui: { agentId: 'agent-a', fallback: ['agent-b'] },
      docs: { agentId: 'agent-b', fallback: ['agent-a'] },
    } as AgentRouteTable,
    logs: [],
  } as never);
});

describe('workflowStore project catalog facade', () => {
  it('upserts project agents and roles through the catalog owner', () => {
    useWorkflowStore.getState().upsertAgent(replacement);
    useWorkflowStore.getState().upsertRole(customRole);

    const state = useWorkflowStore.getState();
    expect(state.agents).toEqual([replacement]);
    expect(state.agents[0]).toBe(replacement);
    expect(state.roles).toEqual([customRole, builtinRole]);
  });

  it('removes an agent with default and route cleanup', () => {
    useWorkflowStore.getState().removeAgent('agent-a');

    const state = useWorkflowStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.defaultAgentId).toBeNull();
    expect(state.agentRouteTable).toEqual({
      ui: { agentId: '', fallback: ['agent-b'] },
      docs: { agentId: 'agent-b', fallback: [] },
    });
  });

  it('preserves builtin-role refusal and original log message', () => {
    useWorkflowStore.getState().removeRole('role-builtin');

    const state = useWorkflowStore.getState();
    expect(state.roles).toEqual([customRole, builtinRole]);
    expect(state.logs.at(-1)?.message).toBe('内置角色不可删除');
    expect(state.logs.at(-1)?.level).toBe('error');
  });

  it('removes custom roles and applies the default-agent patch', () => {
    useWorkflowStore.getState().removeRole('role-a');
    useWorkflowStore.getState().setDefaultAgent('agent-b');

    const state = useWorkflowStore.getState();
    expect(state.roles).toEqual([builtinRole]);
    expect(state.defaultAgentId).toBe('agent-b');
  });
});
