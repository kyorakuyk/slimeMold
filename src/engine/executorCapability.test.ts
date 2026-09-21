import { NodeDefinition } from '../types/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runLlmWithFallback: vi.fn(async (input: { toolSandbox: unknown }) => {
    return input.toolSandbox ? 'sandbox-visible' : 'sandbox-denied';
  }), }));

vi.mock('./runLlmCall', () => ({ runLlmWithFallback: mocks.runLlmWithFallback }));

import type { ExecContext } from '../types/node';
import type { FlowNode } from '../types';
import { registerBuiltins } from '../nodes/builtin';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { runWorkflow } from './executor';

function node(id: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: {
      typeId: 'agent.capability-test',
      label: id,
      params: {},
      status: 'idle',
      dirty: true,
      bypass: false,
      mute: false,
    },
  } as unknown as FlowNode;
}

describe('executor capability boundary', () => {
  beforeEach(() => {
    registerBuiltins();
    useRegistryStore.getState().register([{
      typeId: 'agent.capability-test',
      name: 'capability test',
      category: 'test',
      description: '',
      inputs: [],
      outputs: [{ id: 'out', label: 'out', type: 'text' }],
      params: [],
      execute: (async (_inputs: Record<string, unknown>, _params: Record<string, unknown>, ctx: ExecContext) => ({
        out: await ctx.llm('agent-1', [{ role: 'user', content: 'hello' }]),
      })) as never,
    } as unknown as NodeDefinition]);
    useWorkflowStore.setState({
      activeWfId: 'wf-capability',
      nodes: [node('agent-1')],
      edges: [],
      workflows: {
        'wf-capability': {
          name: 'capability',
          nodes: [node('agent-1')],
          edges: [],
          variables: {},
          agents: [],
          roles: [],
          groups: [],
          assets: [],
        },
      },
      agents: [{ id: 'agent-1', name: 'agent-1', enabled: true, protocol: 'openai', model: 'test' }],
      globalAgents: [],
      agentRouteTable: {},
      defaultAgentId: 'agent-1',
      variables: {},
      projectVariables: {},
      runStates: {},
      logs: [],
      runHistory: [],
      subgraphs: {},
      failFast: true,
      skipFailed: false,
      maxConcurrency: 1,
    } as never);
    mocks.runLlmWithFallback.mockClear();
  });

  it('does not let an io node recover sandbox access through ctx.llm', async () => {
    await runWorkflow({ wfId: 'wf-capability', sandbox: true });
    expect(mocks.runLlmWithFallback).toHaveBeenCalled();
    expect(mocks.runLlmWithFallback.mock.results[0]?.value).toBeInstanceOf(Promise);
    const call = mocks.runLlmWithFallback.mock.calls[0]?.[0] as { toolSandbox: unknown };
    expect(call.toolSandbox).toBeUndefined();
  });
});
