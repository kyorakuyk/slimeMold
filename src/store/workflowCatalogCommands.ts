import type { AgentConfig, RoleTemplate } from '../types/agent';
import type { AgentRouteTable } from '../types/dispatch';
import {
  buildRemoveAgentState,
  buildRemoveRoleState,
  buildSetDefaultAgentState,
  buildUpsertAgentState,
  buildUpsertRoleState,
  upsertById,
} from './projectCatalogState';

export interface WorkflowCatalogState {
  agents: AgentConfig[];
  defaultAgentId: string | null;
  agentRouteTable: AgentRouteTable;
  globalAgents: AgentConfig[];
  roles: RoleTemplate[];
}

export interface WorkflowCatalogPorts<State extends WorkflowCatalogState = WorkflowCatalogState> {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  saveGlobalAgents: (agents: AgentConfig[]) => void | Promise<unknown>;
  getGlobalMasterAgentId: () => string | null;
  clearGlobalMasterAgent: () => void;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function createWorkflowCatalogCommands<State extends WorkflowCatalogState>(
  ports: WorkflowCatalogPorts<State>,
) {
  const setCatalog = (patch: Partial<WorkflowCatalogState>): void => {
    ports.setState(patch as Partial<State>);
  };

  return {
    upsertAgent: (agent: AgentConfig): void => {
      setCatalog(buildUpsertAgentState(ports.getState().agents, agent));
    },

    removeAgent: (id: string): void => {
      setCatalog(buildRemoveAgentState(ports.getState(), id));
    },

    setDefaultAgent: (id: string | null): void => {
      setCatalog(buildSetDefaultAgentState(id));
    },

    setGlobalAgents: (agents: AgentConfig[]): void => {
      setCatalog({ globalAgents: agents });
    },

    upsertGlobalAgent: (agent: AgentConfig): void => {
      const next = upsertById(ports.getState().globalAgents, agent);
      setCatalog({ globalAgents: next });
      void ports.saveGlobalAgents(next);
    },

    removeGlobalAgent: (id: string): void => {
      const next = ports.getState().globalAgents.filter((agent) => agent.id !== id);
      setCatalog({ globalAgents: next });
      if (ports.getGlobalMasterAgentId() === id) ports.clearGlobalMasterAgent();
      void ports.saveGlobalAgents(next);
    },

    upsertRole: (role: RoleTemplate): void => {
      setCatalog(buildUpsertRoleState(ports.getState().roles, role));
    },

    removeRole: (id: string): void => {
      const result = buildRemoveRoleState(ports.getState().roles, id);
      if (result.rejected) {
        ports.addLog('error', result.message ?? '内置角色不可删除');
        return;
      }
      setCatalog({ roles: result.roles });
    },
  };
}
