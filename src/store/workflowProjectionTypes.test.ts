import { describe, expect, it } from 'vitest';
import './workflowProjectionTypes';
import type { WorkflowProjectionState } from './workflowProjectionTypes';

describe('workflow projection state owner', () => {
  it('owns project and Worker projection fields without the facade', () => {
    const state: WorkflowProjectionState = {
      artifacts: {},
      agentRouteTable: {},
      pipelines: [],
      orchestrations: [],
      workerRuns: [],
      workerRunRecoveries: [],
      workerRunEvidence: [],
      workerRunSideEffects: [],
      workerCleanupProposals: [],
      projectControl: {} as never,
    };
    expect(state.workerRuns).toEqual([]);
  });
});
