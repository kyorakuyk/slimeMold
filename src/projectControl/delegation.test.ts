import { describe, expect, it } from 'vitest';
import { createDelegationRequest } from './protocol';
import { emptyDelegationGraph, registerDelegation } from './delegation';

const scope = {
  allowedFiles: ['src/app.ts'],
  allowedDataClasses: ['task'] as const,
  allowedTools: ['read-file', 'delegate-child'] as const,
  allowedAgentRoles: ['worker'] as const,
  maxDelegationDepth: 4,
  maxFanOut: 1,
  maxTokens: 1_000,
  maxCalls: 2,
  maxMoneyCents: 10,
  maxDurationMs: 30_000,
  expiresAt: '2026-09-12T12:00:00.000Z',
};

function request(id: string, parentTaskId: string, childTaskId: string) {
  return createDelegationRequest({
    delegationId: id,
    delegationDepth: 1,
    idempotencyKey: `delegation:${parentTaskId}:${childTaskId}`,
    projectId: 'project-1',
    parentTaskId,
    childTaskId,
    rootTaskId: 'root-task',
    parentRole: 'module-lead',
    requestedRole: 'worker',
    purpose: '受限子任务',
    parentScope: scope,
    policyScope: scope,
    childTaskScope: scope,
    allowedEvidenceRefs: [],
    deadline: '2026-09-12T11:00:00.000Z',
    expectedOutputs: ['结果'],
  });
}

describe('delegation graph', () => {
  it('registers an idempotent delegation only once', () => {
    const first = request('delegation-1', 'task-a', 'task-b');
    const graph = registerDelegation(emptyDelegationGraph('project-1'), first);
    const repeated = registerDelegation(graph, first);

    expect(repeated.requests).toHaveLength(1);
    expect(repeated.requests[0]).toMatchObject({
      delegationId: 'delegation-1',
      idempotencyKey: 'delegation:task-a:task-b',
    });
  });

  it('rejects task cycles and parent fan-out beyond the request budget', () => {
    const initial = emptyDelegationGraph('project-1');
    const first = request('delegation-a-b', 'task-a', 'task-b');
    const second = request('delegation-b-c', 'task-b', 'task-c');
    const cycle = request('delegation-c-a', 'task-c', 'task-a');
    const withFirst = registerDelegation(initial, first);
    const withSecond = registerDelegation(withFirst, second);

    expect(() => registerDelegation(withSecond, cycle)).toThrow(/cycle|环/);
    expect(() => registerDelegation(
      withFirst,
      request('delegation-a-c', 'task-a', 'task-c'),
    )).toThrow(/fan.?out|扇出/);
  });

  it('rejects the same delegation id when its payload changes', () => {
    const graph = registerDelegation(
      emptyDelegationGraph('project-1'),
      request('delegation-1', 'task-a', 'task-b'),
    );

    expect(() => registerDelegation(
      graph,
      request('delegation-1', 'task-a', 'task-c'),
    )).toThrow(/idempotency|内容|delegation/);
  });
});
