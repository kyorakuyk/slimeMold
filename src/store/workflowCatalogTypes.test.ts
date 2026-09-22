import { describe, expect, it } from 'vitest';
import './workflowCatalogTypes';
import type { WorkflowCatalogState } from './workflowCatalogTypes';

describe('workflow catalog state owner', () => {
  it('owns catalog fields without importing the facade', () => {
    const state: WorkflowCatalogState = {
      agents: [],
      defaultAgentId: null,
      globalAgents: [],
      roles: [],
    };
    expect(state.defaultAgentId).toBeNull();
  });
});
