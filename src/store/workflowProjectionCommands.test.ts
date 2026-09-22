import { describe, expect, it, vi } from 'vitest';
import { createWorkflowProjectionCommands } from './workflowProjectionCommands';
import type { WorkflowProjectionState } from './workflowProjectionCommands';

function createState(): WorkflowProjectionState {
  return {
    artifacts: {},
    agentRouteTable: {},
    pipelines: [],
    orchestrations: [],
    workerRuns: [],
    workerRunRecoveries: [],
    workerRunEvidence: [],
    workerRunSideEffects: [],
    workerCleanupProposals: [],
    projectControl: { version: 1 } as never,
  };
}

describe('workflow projection commands', () => {
  it('updates projection fields through explicit state ports', () => {
    let state = createState();
    const setState = (patch: Partial<WorkflowProjectionState>) => {
      state = { ...state, ...patch };
    };
    const normalize = vi.fn((snapshot: WorkflowProjectionState['projectControl']) => ({
      ...snapshot,
      normalized: true,
    }));
    const commands = createWorkflowProjectionCommands({
      getState: () => state,
      setState,
      normalizeProjectControlSnapshot: normalize,
    });

    commands.setArtifact('plan', 'design', { kind: 'design' } as never);
    commands.setWorkerRuns([{ taskId: 'task-1' }] as never);
    commands.setProjectControl({ version: 1 } as never);

    expect(state.artifacts.plan.design).toEqual({ kind: 'design' });
    expect(state.workerRuns).toEqual([{ taskId: 'task-1' }]);
    expect(normalize).toHaveBeenCalledOnce();
    expect(state.projectControl).toMatchObject({ normalized: true });
  });

  it('replaces or appends pipelines without mutating the input state', () => {
    let state = createState();
    const setState = (patch: Partial<WorkflowProjectionState>) => {
      state = { ...state, ...patch };
    };
    const commands = createWorkflowProjectionCommands({
      getState: () => state,
      setState,
      normalizeProjectControlSnapshot: (snapshot) => snapshot,
    });
    const first = { id: 'pipeline-1' } as never;
    const replacement = { id: 'pipeline-1', label: 'updated' } as never;
    const second = { id: 'pipeline-2' } as never;

    commands.upsertPipeline(first);
    commands.upsertPipeline(replacement);
    commands.upsertPipeline(second);

    expect(state.pipelines).toEqual([replacement, second]);
  });
});
