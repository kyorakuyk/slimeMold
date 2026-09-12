import { describe, expect, it } from 'vitest';
import { evaluateReleaseCandidate, type ReleaseGateReceipt } from './releaseGate';

const receipt = (kind: ReleaseGateReceipt['kind'], passed = true): ReleaseGateReceipt => ({
  kind,
  id: `${kind}-receipt`,
  projectId: 'project-1',
  passed,
  independent: kind !== 'integration' || true,
  reviewerId: `${kind}-reviewer`,
  evidenceRefs: [{ id: `${kind}-evidence`, version: 1 }],
  blockingIssues: [],
  sourceVersion: 4,
  observedAt: '2026-09-12T12:00:00.000Z',
});

describe('release gate', () => {
  it('allows a candidate only after independent QA, security, and integration pass', () => {
    const result = evaluateReleaseCandidate({
      candidateId: 'release-1',
      projectId: 'project-1',
      planId: 'plan-1',
      planVersion: 3,
      planApproved: true,
      qa: receipt('qa'),
      security: receipt('security'),
      integration: receipt('integration'),
      highImpact: false,
    });

    expect(result).toMatchObject({ status: 'ready', allowed: true });
    expect(result.evidenceRefs).toEqual([
      { id: 'qa-evidence', version: 1 },
      { id: 'security-evidence', version: 1 },
      { id: 'integration-evidence', version: 1 },
    ]);
  });

  it('blocks release when a review fails or is not independent', () => {
    const security = { ...receipt('security', false), blockingIssues: ['permission escalation'] };
    const result = evaluateReleaseCandidate({
      candidateId: 'release-2',
      projectId: 'project-1',
      planId: 'plan-1',
      planVersion: 3,
      planApproved: true,
      qa: receipt('qa'),
      security,
      integration: { ...receipt('integration'), independent: false },
      highImpact: false,
    });

    expect(result).toMatchObject({ status: 'blocked', allowed: false });
    expect(result.reasons).toEqual(expect.arrayContaining([
      'security review failed',
      'integration review is not independent',
    ]));
  });

  it('requires explicit user approval for high-impact release', () => {
    const result = evaluateReleaseCandidate({
      candidateId: 'release-3',
      projectId: 'project-1',
      planId: 'plan-1',
      planVersion: 3,
      planApproved: true,
      qa: receipt('qa'),
      security: receipt('security'),
      integration: receipt('integration'),
      highImpact: true,
    });

    expect(result).toMatchObject({ status: 'blocked', allowed: false });
    expect(result.reasons).toContain('high-impact release requires user approval');
  });

  it('blocks cross-project gate evidence', () => {
    const result = evaluateReleaseCandidate({
      candidateId: 'release-4',
      projectId: 'project-1',
      planId: 'plan-1',
      planVersion: 3,
      planApproved: true,
      qa: receipt('qa'),
      security: { ...receipt('security'), projectId: 'project-2' },
      integration: receipt('integration'),
      highImpact: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('security receipt belongs to another project');
  });

  it('does not accept a receipt of the wrong kind in a gate slot', () => {
    const result = evaluateReleaseCandidate({
      candidateId: 'release-kind-mismatch',
      projectId: 'project-1',
      planId: 'plan-1',
      planVersion: 3,
      planApproved: true,
      qa: receipt('qa'),
      security: receipt('qa'),
      integration: receipt('integration'),
      highImpact: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('security receipt kind mismatch');
  });
});
