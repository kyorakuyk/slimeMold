import { describe, expect, it, vi } from 'vitest';
import type { AgentDecisionResult } from '../agents/agentDecision';
import type { RunLlmCallInput } from './runLlmCall';
import { createEventBus } from './runEvents';
import { createNodeLlmAdapter } from './nodeLlmAdapter';

describe('node LLM adapter', () => {
  it('routes, emits telemetry, injects experience, and forwards execution tools', async () => {
    const bus = createEventBus();
    const runLlmWithFallback = vi.fn(async (input: RunLlmCallInput) => {
      expect(input.toolStorage).toEqual({ get: expect.any(Function), set: expect.any(Function) });
      expect(input.toolSandbox).toBe('sandbox');
      expect(input.effectiveMessages[0]?.content).toContain('历史经验');
      return 'answer';
    });
    const decideAgentCall = vi.fn(() => ({
      decision: {
        agent: { id: 'agent-1', name: 'Agent One' },
        chain: ['agent-1'],
        reason: 'category',
        routed: true,
        scores: [],
      },
      routed: true,
      mergedAgents: [{ id: 'agent-1' }],
      routeLog: 'routed to Agent One',
    }) as unknown as AgentDecisionResult);

    const llm = createNodeLlmAdapter({
      node: { id: 'node-1', label: 'Node One', typeId: 'agent.chat', params: { category: 'code' } },
      targetWfId: 'wf-1',
      targetRunId: 3,
      myRun: 3,
      nodeCtx: { wfId: 'wf-1', runId: 3 },
      runBus: bus,
      signal: new AbortController().signal,
      limiter: {} as never,
      maxRetries: 2,
      retryBaseMs: 10,
      sink: null,
      getState: () => ({
        activeWfId: 'wf-1',
        workflowName: 'Goal',
        workflows: {},
        agents: [],
        globalAgents: [],
        agentRouteTable: {},
        defaultAgentId: null,
        projectId: 'project-1',
        llmChannel: 'backend',
      }),
      getTools: () => ({
        vars: { answer: 42 },
        storage: { get: vi.fn(), set: vi.fn() },
        sandbox: 'sandbox' as never,
      }),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      recordCost: vi.fn(),
      decideAgentCall,
      runLlmWithFallback,
      matchExperience: () => [{ insights: ['use the prior result'], summary: 'prior' }] as never,
    });

    await expect(llm('requested', [{ role: 'user', content: 'hello' }])).resolves.toBe('answer');
    expect(decideAgentCall).toHaveBeenCalledOnce();
    expect(bus.history('wf-1', 3).map((event) => event.kind)).toEqual(['node.progress', 'node.progress']);
  });
});
