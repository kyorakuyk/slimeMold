import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode } from '../types';
import { registerBuiltins } from '../nodes/builtin';
import { useWorkflowStore } from '../store/workflowStore';
import { runWorkflow, stopWorkflow, getActiveRunId } from './executor';
import { clearCache, beginRun } from './nodeCache';
import { EventLogWriter, resetEventLog, setEventPersistenceMode } from './eventLog';

function mkNode(id: string, typeId: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: { typeId, label: id, params: { text: 'fixture' }, status: 'idle', dirty: true, bypass: false, mute: false },
  } as unknown as FlowNode;
}

function seedStore(wfId: string): void {
  const nodes = [mkNode('source', 'input.text')];
  const edges: FlowEdge[] = [];
  useWorkflowStore.setState({
    activeWfId: wfId,
    workflowName: wfId,
    nodes,
    edges,
    variables: {},
    projectVariables: {},
    workflows: {
      [wfId]: {
        name: wfId,
        nodes,
        edges,
        variables: {},
        agents: [],
        roles: [],
        groups: [],
        assets: [],
      },
    },
    runStates: {},
    runHistory: [],
    logs: [],
    subgraphs: {},
    failFast: true,
    skipFailed: false,
    maxConcurrency: 3,
    projectPath: null,
  } as never);
}

describe('runWorkflow lifecycle regressions', () => {
  beforeEach(() => {
    registerBuiltins();
    clearCache();
    beginRun();
    resetEventLog();
  });

  afterEach(() => {
    resetEventLog();
  });

  it('marks a non-sandbox run active before yielding, rejects a duplicate, and keeps an immediate stop final', async () => {
    const wfId = 'wf-r4-s9-start-order';
    seedStore(wfId);

    const firstRun = runWorkflow({ wfId });
    const activeRunId = getActiveRunId(wfId);
    const runningImmediately = useWorkflowStore.getState().runStates[wfId]?.running;
    const duplicateRun = runWorkflow({ wfId });
    const activeRunAfterDuplicate = getActiveRunId(wfId);

    stopWorkflow(wfId);
    await Promise.all([firstRun, duplicateRun]);

    expect(runningImmediately).toBe(true);
    expect(activeRunAfterDuplicate).toBe(activeRunId);
    expect(useWorkflowStore.getState().runStates[wfId]?.running).toBe(false);
  });

  it('detaches an attached event log when session initialization throws', async () => {
    const wfId = 'wf-r4-s9-event-log-cleanup';
    seedStore(wfId);
    const store = useWorkflowStore.getState();
    const originalResetUsage = store.resetUsage;
    const closeEventLog = vi.spyOn(EventLogWriter.prototype, 'close');

    useWorkflowStore.setState({
      projectPath: 'disposable-event-log-fixture',
      resetUsage: () => {
        throw new Error('injected resetUsage failure');
      },
    } as never);
    setEventPersistenceMode('summary');

    try {
      await expect(runWorkflow({ wfId })).rejects.toThrow('injected resetUsage failure');
      expect(closeEventLog).toHaveBeenCalledTimes(1);
    } finally {
      closeEventLog.mockRestore();
      useWorkflowStore.setState({ resetUsage: originalResetUsage } as never);
      resetEventLog();
    }
  });
});
