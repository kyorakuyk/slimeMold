import { describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  ChatMessage,
  CostRecord,
  LLMResponse,
  RoleTemplate,
} from './agent';

describe('agent contract owner', () => {
  it('keeps provider, role, message, and cost contracts structurally usable', () => {
    const agent = {
      id: 'agent-1',
      name: 'Builder',
      protocol: 'codex',
      baseUrl: '',
      model: 'gpt-5',
    } satisfies AgentConfig;
    const role = {
      id: 'role-1',
      name: 'Builder',
      system: 'Build the requested change.',
    } satisfies RoleTemplate;
    const message = {
      role: 'user',
      content: 'Implement the change.',
    } satisfies ChatMessage;
    const response = {
      text: 'done',
      usage: { totalTokens: 3 },
    } satisfies LLMResponse;
    const cost = {
      nodeId: 'node-1',
      nodeLabel: 'Worker',
      agentId: agent.id,
      model: agent.model,
      durationMs: 12,
      at: '2026-09-21T00:00:00.000Z',
      ok: true,
    } satisfies CostRecord;

    expect({ agent, role, message, response, cost }).toMatchObject({
      agent: { protocol: 'codex' },
      role: { id: 'role-1' },
      message: { role: 'user' },
      response: { text: 'done' },
      cost: { ok: true },
    });
  });
});
