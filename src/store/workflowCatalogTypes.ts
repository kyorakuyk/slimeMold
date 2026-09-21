import type { AgentConfig, RoleTemplate } from '../types/agent';

/** Agent/Role catalog fields owned by the workflow catalog boundary. */
export interface WorkflowCatalogState {
  agents: AgentConfig[];
  defaultAgentId: string | null;
  globalAgents: AgentConfig[];
  roles: RoleTemplate[];
}
