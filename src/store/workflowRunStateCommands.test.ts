import { describe, expect, it, vi } from 'vitest';
import type { RunCheckpoint } from '../engine/checkpoint';
import type { RunRecord } from '../types/execution';
import {
  createWorkflowRunStateCommands,
  type WorkflowRunStateShape,
} from './workflowRunStateCommands';

interface TestState extends WorkflowRunStateShape {}

function createHarness() {
  let state: TestState = {
    activeWfId: 'wf-1',
    runStates: {},
    running: false,
    runProgress: { active: false, layer: 0, totalLayers: 0, round: 0, totalRounds: 0 },
    costLog: [],
    runHistory: [],
    checkpoints: {},
    checkpointHistory: {},
    nodes: [],
    workflows: { 'wf-2': { nodes: [] } },
    projectPath: '/project',
  };
  const saveCheckpointToDisk = vi.fn(async () => true);
  const commands = createWorkflowRunStateCommands<TestState>({
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    updateState: (updater) => {
      state = { ...state, ...updater(state) };
    },
    setDirtySuppressed: vi.fn(),
    saveCheckpointToDisk,
  });
  return { getState: () => state, commands, saveCheckpointToDisk };
}

const checkpoint: RunCheckpoint = {
  wfId: 'wf-1',
  runId: 1,
  status: 'success',
  startedAt: 1,
  endedAt: 2,
  nodes: {},
};

describe('workflow run state command owner', () => {
  it('keeps per-workflow progress and active-workflow compatibility in sync', () => {
    const harness = createHarness();
    harness.commands.setRunning(true, 'wf-2');
    harness.commands.setRunProgress({ active: true, layer: 2 }, 'wf-1');

    expect(harness.getState().runStates['wf-2']?.running).toBe(true);
    expect(harness.getState().runProgress).toMatchObject({ active: true, layer: 2 });
    expect(harness.getState().running).toBe(false);
  });

  it('updates checkpoint memory, history, persistence, and restore through explicit ports', async () => {
    const harness = createHarness();
    harness.commands.setCheckpoint(checkpoint);
    await harness.commands.persistCheckpointSnapshot(checkpoint);
    expect(harness.getState().checkpoints['wf-1']).toBe(checkpoint);
    expect(harness.getState().checkpointHistory['wf-1']).toHaveLength(1);
    expect(harness.saveCheckpointToDisk).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ 'wf-1': checkpoint }),
      expect.objectContaining({ 'wf-1': expect.any(Array) }),
    );
    expect(harness.commands.restoreCheckpoint()).toBe(true);

    const record = {} as RunRecord;
    harness.commands.pushRunHistory(record);
    expect(harness.getState().runHistory).toEqual([record]);
  });
});
