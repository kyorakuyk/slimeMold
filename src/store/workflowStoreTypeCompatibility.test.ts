import { describe, expect, it } from 'vitest';
import type {
  ProjectSaveGuard,
  RunProgressShape,
  RunState,
  WorkflowState,
} from './workflowStore';

describe('workflow store type compatibility facade', () => {
  it('keeps the state contracts available from the historical facade path', () => {
    const progress: RunProgressShape = {
      active: false,
      layer: 0,
      totalLayers: 0,
      round: 0,
      totalRounds: 0,
    };
    const runState: RunState = { running: false, progress };
    const guard: ProjectSaveGuard = {
      projectId: 'project-1',
      projectPath: 'C:/project',
    };
    const partial: Partial<WorkflowState> = {
      runStates: { 'wf-1': runState },
      projectId: guard.projectId,
      projectPath: guard.projectPath,
    };

    expect(partial).toMatchObject({ projectId: 'project-1', projectPath: 'C:/project' });
  });
});
