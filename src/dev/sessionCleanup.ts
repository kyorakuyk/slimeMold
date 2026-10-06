import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { cleanupBindingFingerprint } from '../projectControl/workerCleanup';
import type { AcceptanceRecord, CleanupApproval } from './sessionContracts';
import type { WorktreeManager } from './worktree';
import { pathComparisonKey } from './path-utils';

export interface ConfirmSessionCleanupInput {
  path: string;
  signal?: AbortSignal;
  expectedFingerprint?: string;
  manager: WorktreeManager;
  confirmCleanupInFlight: Set<string>;
  approvedCleanups: Map<string, CleanupApproval>;
  trustedCleanupBindings: Set<string>;
  getAcceptance(acceptanceId: string): AcceptanceRecord | undefined;
  computeWorktreeSignature(path: string): Promise<string>;
  consumeCleanup(path: string): void;
}

export async function confirmSessionCleanup(input: ConfirmSessionCleanupInput): Promise<boolean> {
  const {
    path,
    signal,
    expectedFingerprint,
    manager,
    confirmCleanupInFlight,
    approvedCleanups,
    trustedCleanupBindings,
    getAcceptance,
    computeWorktreeSignature,
    consumeCleanup,
  } = input;
  const key = pathComparisonKey(path);
  if (signal?.aborted || confirmCleanupInFlight.has(key)) return false;
  confirmCleanupInFlight.add(key);
  try {
    const approval = approvedCleanups.get(key);
    const info = manager.getByPath(path);
    if (!approval || approval.consumed) return false;
    const rejectCleanup = (): boolean => {
      trustedCleanupBindings.delete(cleanupBindingFingerprint(approval));
      approvedCleanups.set(key, { ...approval, consumed: true });
      return false;
    };
    if (!expectedFingerprint?.trim()) return false;
    if (!trustedCleanupBindings.has(expectedFingerprint)
      || cleanupBindingFingerprint(approval) !== expectedFingerprint) return rejectCleanup();
    if (approval.taskStatus !== 'succeeded'
      || approval.cleanupStatus !== 'active'
      || approval.branchRevisionRequired !== true
      || typeof approval.attempt !== 'number'
      || !Number.isSafeInteger(approval.attempt)
      || approval.attempt < 1) return rejectCleanup();
    if (!approval.worktreeId || !approval.branch
      || !approval.runId || !approval.taskId || !approval.taskExecutionId || !approval.attemptId
      || !info
      || info.id !== approval.worktreeId
      || info.branch !== approval.branch) return rejectCleanup();
    if (approval.targetIdentity !== info.targetIdentity) return rejectCleanup();
    if (approval.taskExecutionId !== createTaskExecutionId(approval.runId, approval.taskId)
      || approval.attemptId !== createAttemptId(approval.taskExecutionId, approval.attempt)) return rejectCleanup();
    if (!approval.acceptanceId || !approval.stateSignature || !approval.baseRevision) return rejectCleanup();
    const acc = getAcceptance(approval.acceptanceId);
    const accOk = !!acc
      && acc.passed
      && acc.orchestrationId === approval.orchestrationId
      && acc.stageId === approval.stageId
      && acc.runId === approval.runId
      && acc.taskId === approval.taskId
      && acc.taskExecutionId === approval.taskExecutionId
      && acc.attemptId === approval.attemptId
      && pathComparisonKey(acc.worktreePath) === key;
    const revOk = info.baseRevision === approval.baseRevision;
    const branchRevisionOk = info.status === 'created'
      ? !!approval.branchRevision
      : !!approval.branchRevision && info.branchRevision === approval.branchRevision;
    if (!branchRevisionOk) return rejectCleanup();
    if (info.status === 'created') {
      const liveBranchRevision = await manager.getBranchRevision(approval.branch);
      if (liveBranchRevision !== approval.branchRevision) return rejectCleanup();
    }
    if (info.status === 'registration-pending' || info.status === 'orphaned') {
      if (!accOk || !revOk) return rejectCleanup();
      const cleaned = await manager.cleanup(info.id, {
        confirm: true,
        signal,
        branchRevision: approval.branchRevision,
      });
      if (cleaned) {
        consumeCleanup(path);
        return true;
      }
      return rejectCleanup();
    }
    const signature = await computeWorktreeSignature(path);
    if (signal?.aborted) return false;
    if (!accOk || !revOk || signature !== approval.stateSignature) return rejectCleanup();
    const finalSignature = await computeWorktreeSignature(path);
    if (signal?.aborted) return false;
    if (finalSignature !== approval.stateSignature) return rejectCleanup();
    const cleaned = await manager.cleanup(info.id, {
      confirm: true,
      signal,
      branchRevision: approval.branchRevision,
    });
    if (cleaned) {
      consumeCleanup(path);
      return true;
    }
    return rejectCleanup();
  } finally {
    confirmCleanupInFlight.delete(key);
  }
}
