import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowEdge, FlowNode } from '../types';
import type { NodeDefinition } from '../types/node';
import { registerBuiltins } from '../nodes/builtin';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { runWorkflow, stopWorkflow, getActiveRunId } from './executor';
import { clearCache, beginRun } from './nodeCache';
import { EventLogWriter, resetEventLog, setEventPersistenceMode } from './eventLog';
import { getRunBus, resetRunBus } from './runEvents';

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

  it('keeps copy-sandbox startup synchronous, rejects a duplicate, and keeps an immediate stop final', async () => {
    const wfId = 'wf-r5-s3-copy-sandbox-start-order';
    seedStore(wfId);

    const firstRun = runWorkflow({ wfId, sandbox: true, sandboxMode: 'copy' });
    const activeRunId = getActiveRunId(wfId);
    const runningImmediately = useWorkflowStore.getState().runStates[wfId]?.running;
    const duplicateRun = runWorkflow({ wfId, sandbox: true, sandboxMode: 'copy' });
    const activeRunAfterDuplicate = getActiveRunId(wfId);

    stopWorkflow(wfId);
    await Promise.all([firstRun, duplicateRun]);

    expect(runningImmediately).toBe(true);
    expect(activeRunAfterDuplicate).toBe(activeRunId);
    expect(useWorkflowStore.getState().runStates[wfId]?.running).toBe(false);
  });

  it('reads an upstream output getter after the downstream node-start event', async () => {
    const wfId = 'wf-r5-s4-input-read-order';
    seedStore(wfId);
    const order: string[] = [];
    const originalDefs = useRegistryStore.getState().defs;
    const sourceOutputs: Record<string, unknown> = {};
    Object.defineProperty(sourceOutputs, 'out', {
      get: () => {
        order.push('read A.out');
        return 'source-value';
      },
    });
    const definitions: NodeDefinition[] = [
      {
        typeId: 'test.orderSource', name: 'Source', category: 'test', inputs: [],
        outputs: [{ id: 'out', label: 'Output', type: 'text' }], params: [],
        execute: async () => sourceOutputs,
      },
      {
        typeId: 'test.orderTarget', name: 'Target', category: 'test',
        inputs: [{ id: 'in', label: 'Input', type: 'text' }], outputs: [], params: [],
        execute: async (inputs) => {
          order.push('execute B');
          expect(inputs.in).toBe('source-value');
          return {};
        },
      },
    ];
    useRegistryStore.getState().register(definitions);
    const nodes = [mkNode('A', 'test.orderSource'), mkNode('B', 'test.orderTarget')];
    const edges: FlowEdge[] = [{
      id: 'A-to-B', source: 'A', sourceHandle: 'out', target: 'B', targetHandle: 'in',
    } as FlowEdge];
    const current = useWorkflowStore.getState();
    useWorkflowStore.setState({
      nodes,
      edges,
      workflows: { ...current.workflows, [wfId]: { ...current.workflows[wfId], nodes, edges } },
    } as never);
    const unsubscribe = getRunBus().subscribe((event) => {
      if (event.kind === 'node.started' && event.nodeId === 'B') order.push('node.started:B');
    });

    try {
      const result = await runWorkflow({ wfId, forceNodes: ['B'] });
      expect(result.status).toBe('success');
      expect(order).toEqual(['node.started:B', 'read A.out', 'execute B']);
    } finally {
      unsubscribe();
      useRegistryStore.setState({ defs: originalDefs });
      resetRunBus();
    }
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
