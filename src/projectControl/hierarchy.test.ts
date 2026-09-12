import { describe, expect, it } from 'vitest';
import {
  canDelegateProjectRole,
  intersectChildScope,
  validateAgentScope,
  type AgentScope,
} from './hierarchy';

const parentScope: AgentScope = {
  allowedFiles: ['src/app.ts', 'src/core.ts'],
  allowedDataClasses: ['task', 'evidence', 'source-file'],
  allowedTools: ['read-file', 'run-tests', 'request-feedback'],
  allowedAgentRoles: ['worker', 'specialist'],
  maxDelegationDepth: 4,
  maxFanOut: 8,
  maxTokens: 10_000,
  maxCalls: 20,
  maxMoneyCents: 500,
  maxDurationMs: 120_000,
  expiresAt: '2026-09-12T12:00:00.000Z',
};

const policyScope: AgentScope = {
  allowedFiles: ['src/app.ts', 'src/other.ts'],
  allowedDataClasses: ['task', 'source-file'],
  allowedTools: ['read-file', 'request-feedback'],
  allowedAgentRoles: ['worker'],
  maxDelegationDepth: 2,
  maxFanOut: 3,
  maxTokens: 4_000,
  maxCalls: 9,
  maxMoneyCents: 200,
  maxDurationMs: 60_000,
  expiresAt: '2026-09-12T11:00:00.000Z',
};

const childTaskScope: AgentScope = {
  allowedFiles: ['src/app.ts'],
  allowedDataClasses: ['task'],
  allowedTools: ['read-file'],
  allowedAgentRoles: ['worker'],
  maxDelegationDepth: 1,
  maxFanOut: 1,
  maxTokens: 1_000,
  maxCalls: 2,
  maxMoneyCents: 50,
  maxDurationMs: 30_000,
  expiresAt: '2026-09-12T10:30:00.000Z',
};

describe('intersectChildScope', () => {
  it('takes the intersection of parent, policy, and child scope', () => {
    const result = intersectChildScope(parentScope, policyScope, childTaskScope);

    expect(result).toEqual({
      allowedFiles: ['src/app.ts'],
      allowedDataClasses: ['task'],
      allowedTools: ['read-file'],
      allowedAgentRoles: ['worker'],
      maxDelegationDepth: 1,
      maxFanOut: 1,
      maxTokens: 1_000,
      maxCalls: 2,
      maxMoneyCents: 50,
      maxDurationMs: 30_000,
      expiresAt: '2026-09-12T10:30:00.000Z',
    });
  });

  it('keeps an empty intersection instead of widening a child request', () => {
    const result = intersectChildScope(
      parentScope,
      policyScope,
      { ...childTaskScope, allowedFiles: ['docs/secret.md'] },
    );

    expect(result.allowedFiles).toEqual([]);
    expect(result.allowedDataClasses).toEqual(['task']);
  });

  it('does not mutate any source scope', () => {
    const before = JSON.stringify({ parentScope, policyScope, childTaskScope });
    intersectChildScope(parentScope, policyScope, childTaskScope);
    expect(JSON.stringify({ parentScope, policyScope, childTaskScope })).toBe(before);
  });
});

describe('canDelegateProjectRole', () => {
  it('keeps the contractor between CEO and Department Head', () => {
    expect(canDelegateProjectRole('master-ceo', 'project-delivery-architect')).toBe(true);
    expect(canDelegateProjectRole('project-delivery-architect', 'department-head')).toBe(true);
    expect(canDelegateProjectRole('department-head', 'module-lead')).toBe(true);
    expect(canDelegateProjectRole('module-lead', 'worker')).toBe(true);
  });

  it('does not let a Worker delegate upward or create an assurance authority', () => {
    expect(canDelegateProjectRole('worker', 'project-delivery-architect')).toBe(false);
    expect(canDelegateProjectRole('worker', 'security-risk-reviewer')).toBe(false);
    expect(canDelegateProjectRole('specialist', 'worker')).toBe(false);
  });

  it('rejects malformed budgets and expiry timestamps', () => {
    expect(() => validateAgentScope({
      ...parentScope,
      maxTokens: -1,
    }, 'scope')).toThrow(/maxTokens/);
    expect(() => validateAgentScope({
      ...parentScope,
      expiresAt: 'later',
    }, 'scope')).toThrow(/expiresAt/);
  });
});
