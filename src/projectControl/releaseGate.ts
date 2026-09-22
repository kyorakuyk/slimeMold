import type { PlanningReference } from './types';

export type ReleaseGateReceiptKind = 'qa' | 'security' | 'integration';

export interface ReleaseGateReceipt {
  kind: ReleaseGateReceiptKind;
  id: string;
  projectId: string;
  passed: boolean;
  independent: boolean;
  reviewerId: string;
  evidenceRefs: readonly PlanningReference[];
  blockingIssues: readonly string[];
  sourceVersion: number;
  observedAt: string;
}

export interface ReleaseUserApproval {
  approvedBy: string;
  approvedAt: string;
}

export interface EvaluateReleaseCandidateInput {
  candidateId: string;
  projectId: string;
  planId: string;
  planVersion: number;
  planApproved: boolean;
  qa: ReleaseGateReceipt;
  security: ReleaseGateReceipt;
  integration: ReleaseGateReceipt;
  highImpact: boolean;
  userApproval?: ReleaseUserApproval;
}

export interface ReleaseCandidate {
  candidateId: string;
  projectId: string;
  planId: string;
  planVersion: number;
  status: 'ready' | 'blocked';
  allowed: boolean;
  evidenceRefs: readonly PlanningReference[];
  reasons: readonly string[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function requiredPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是大于 0 的安全整数`);
  return value;
}

function uniqueReferences(receipts: readonly ReleaseGateReceipt[]): PlanningReference[] {
  const seen = new Set<string>();
  const references: PlanningReference[] = [];
  for (const receipt of receipts) {
    for (const reference of receipt.evidenceRefs) {
      const id = requiredText(reference.id, 'evidence reference id');
      const version = requiredPositiveInteger(reference.version, 'evidence reference version');
      const key = `${id}:${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ id, version });
    }
  }
  return references;
}

export function evaluateReleaseCandidate(
  input: EvaluateReleaseCandidateInput,
): ReleaseCandidate {
  const candidateId = requiredText(input.candidateId, 'candidateId');
  const projectId = requiredText(input.projectId, 'projectId');
  const planId = requiredText(input.planId, 'planId');
  const planVersion = requiredPositiveInteger(input.planVersion, 'planVersion');
  const receipts: ReadonlyArray<{ expectedKind: ReleaseGateReceiptKind; receipt: ReleaseGateReceipt }> = [
    { expectedKind: 'qa', receipt: input.qa },
    { expectedKind: 'security', receipt: input.security },
    { expectedKind: 'integration', receipt: input.integration },
  ];
  const reasons: string[] = [];

  if (!input.planApproved) reasons.push('project plan is not approved');
  for (const { expectedKind, receipt } of receipts) {
    if (receipt.kind !== expectedKind) reasons.push(`${expectedKind} receipt kind mismatch`);
    if (receipt.projectId !== projectId) reasons.push(`${expectedKind} receipt belongs to another project`);
    if (!receipt.passed) reasons.push(`${expectedKind} review failed`);
    if (!receipt.independent) reasons.push(`${expectedKind} review is not independent`);
    if (receipt.blockingIssues.length > 0) reasons.push(`${expectedKind} review has blocking issues`);
  }
  if (input.highImpact && !input.userApproval) {
    reasons.push('high-impact release requires user approval');
  }
  if (input.highImpact && input.userApproval) {
    requiredText(input.userApproval.approvedBy, 'approvedBy');
    requiredText(input.userApproval.approvedAt, 'approvedAt');
  }

  return {
    candidateId,
    projectId,
    planId,
    planVersion,
    status: reasons.length === 0 ? 'ready' : 'blocked',
    allowed: reasons.length === 0,
    evidenceRefs: uniqueReferences(receipts.map(({ receipt }) => receipt)),
    reasons,
  };
}
