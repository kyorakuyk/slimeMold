import { describe, expect, it } from 'vitest';
import { createContextPack, type ContextPack } from './protocol';
import { assertContextAccess, checkContextAccess } from './contextPack';

const scope = {
  allowedFiles: ['src/app.ts'],
  allowedDataClasses: ['task', 'evidence'] as const,
  allowedTools: ['read-file', 'read-evidence', 'run-tests'] as const,
  allowedAgentRoles: ['worker'] as const,
  maxDelegationDepth: 1,
  maxFanOut: 1,
  maxTokens: 1_000,
  maxCalls: 2,
  maxMoneyCents: 10,
  maxDurationMs: 30_000,
  expiresAt: '2026-09-12T12:00:00.000Z',
};

const pack: ContextPack = createContextPack({
  schemaVersion: 1,
  contextPackId: 'context-pack-1',
  projectId: 'project-1',
  taskId: 'task-1',
  taskExecutionId: 'execution-1',
  attemptId: 'attempt-1',
  contextVersion: 1,
  goal: '完成模块任务',
  nonGoals: ['不修改部署'],
  decisionRefs: [],
  evidenceRefs: [],
  requiredFiles: ['src/app.ts'],
  requiredDocuments: [],
  dependencyRefs: [],
  acceptanceCriteria: ['测试通过'],
  scope,
  sourceVersion: 1,
});

describe('ContextPack access gateway', () => {
  it('allows only declared files, data classes, tools, and roles', () => {
    expect(checkContextAccess(pack, { kind: 'file', value: 'src/app.ts' })).toMatchObject({ allowed: true });
    expect(checkContextAccess(pack, { kind: 'data-class', value: 'evidence' })).toMatchObject({ allowed: true });
    expect(checkContextAccess(pack, { kind: 'tool', value: 'run-tests' })).toMatchObject({ allowed: true });
    expect(checkContextAccess(pack, { kind: 'agent-role', value: 'worker' })).toMatchObject({ allowed: true });
  });

  it('denies out-of-pack access without widening the ContextPack', () => {
    expect(checkContextAccess(pack, { kind: 'file', value: 'src/secret.ts' })).toMatchObject({ allowed: false });
    expect(checkContextAccess(pack, { kind: 'data-class', value: 'raw-transcript' })).toMatchObject({ allowed: false });
    expect(checkContextAccess(pack, { kind: 'tool', value: 'merge' })).toMatchObject({ allowed: false });
    expect(() => assertContextAccess(pack, { kind: 'file', value: 'src/secret.ts' })).toThrow(/ContextPack|scope/);
  });
});
