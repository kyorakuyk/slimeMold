import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecContext, NodeDefinition } from '../types/node';
import type { FlowNode } from '../types/graph';
import type { ExecutionRuntime } from './runtime';
import { handleNodeFailure } from './nodeResultHandler';
import { runNodeWithRetry } from './executorNodePhases';

vi.mock('./nodeResultHandler', () => ({
  handleNodeFailure: vi.fn(),
  handleNodeSuccess: vi.fn(),
}));

function makeRunInput(overrides: {
  getInputs?: () => Record<string, unknown>;
  getCurrentRunId?: () => number;
  execute?: NodeDefinition['execute'];
  setStatus?: ReturnType<typeof vi.fn>;
  emit?: ReturnType<typeof vi.fn>;
  addLog?: ReturnType<typeof vi.fn>;
  callOrder?: string[];
} = {}): Parameters<typeof runNodeWithRetry>[0] {
  const callOrder = overrides.callOrder ?? [];
  const node = {
    id: 'node-1',
    data: { label: 'Agent', typeId: 'agent.test', params: {} },
  } as unknown as FlowNode;
  const def = {
    typeId: 'agent.test',
    name: 'Agent',
    category: 'test',
    description: '',
    inputs: [],
    outputs: [],
    params: [],
    execute: overrides.execute ?? (async () => ({})),
  } as unknown as NodeDefinition;

  const args = {
    id: 'node-1',
    node,
    def,
    ctx: {} as ExecContext,
    targetWfId: 'wf-test',
    targetRunId: 1,
    myRun: 1,
    signal: new AbortController().signal,
    R: {
      addLog: overrides.addLog ?? (() => callOrder.push('agent-log')),
    } as unknown as ExecutionRuntime,
    emit: overrides.emit ?? ((kind: string) => callOrder.push(`emit:${kind}`)),
    setStatus: overrides.setStatus ?? ((...args: unknown[]) => callOrder.push(`status:${String(args[1])}`)),
    getBranchesTaken: () => undefined,
    getInputs: overrides.getInputs ?? (() => {
      callOrder.push('inputs');
      return {};
    }),
    edges: [],
    outputsMap: new Map(),
    branchState: new Map(),
    failed: new Set(),
    cutSet: new Set(),
    stopAfter: new Set(),
    cacheScope: 'test',
    getCurrentRunId: overrides.getCurrentRunId ?? (() => 1),
    onSnapshot: () => {},
  };

  return args as unknown as Parameters<typeof runNodeWithRetry>[0];
}

describe('runNodeWithRetry input timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects inputs after the generation guard and node-start lifecycle callbacks', async () => {
    const callOrder: string[] = [];
    const execute = vi.fn(async () => {
      callOrder.push('execute');
      return {};
    });
    const getInputs = vi.fn(() => {
      callOrder.push('inputs');
      return {};
    });

    await runNodeWithRetry(makeRunInput({ callOrder, execute, getInputs }));

    expect(callOrder.slice(0, 5)).toEqual([
      'status:running',
      'emit:node.started',
      'agent-log',
      'inputs',
      'execute',
    ]);
  });

  it('does not collect inputs when the run generation is already stale', async () => {
    const getInputs = vi.fn(() => ({}));
    const setStatus = vi.fn();
    const emit = vi.fn();
    const addLog = vi.fn();

    await runNodeWithRetry(makeRunInput({
      getInputs,
      getCurrentRunId: () => 2,
      setStatus,
      emit,
      addLog,
    }));

    expect(getInputs).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(addLog).not.toHaveBeenCalled();
  });

  it('keeps input collection errors outside the node execution failure handler', async () => {
    const error = new Error('input read failed');
    const getInputs = vi.fn(() => { throw error; });

    await expect(runNodeWithRetry(makeRunInput({ getInputs }))).rejects.toBe(error);
    expect(handleNodeFailure).not.toHaveBeenCalled();
  });
});
