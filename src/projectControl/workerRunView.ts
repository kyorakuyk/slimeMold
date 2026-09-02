import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from './workerCleanup';

export interface WorkerEvidenceView {
  id: string;
  kind: EvidenceRecord['kind'];
  status: EvidenceRecord['status'];
  command?: string;
  exitCode?: number;
  summary: string;
  createdAt: string;
}

export interface WorkerSideEffectView {
  idempotencyKey: string;
  kind: string;
  status: SideEffectRecord['status'];
  recovery?: SideEffectRecord['recovery'];
  receiptId?: string;
  unknownReason?: string;
}

export interface WorkerTaskView {
  taskId: string;
  status: WorkerRunQueueState['tasks'][string]['status'];
  attempt: number;
  error?: string;
  evidenceIds: string[];
  evidence: WorkerEvidenceView[];
  sideEffects: WorkerSideEffectView[];
  cleanup?: WorkerCleanupProposal;
  worktreePath?: string;
}

export interface WorkerRunView {
  runId: string;
  orchestrationId?: string;
  status: WorkerRunQueueState['status'];
  updatedAt: string;
  recovery?: WorkerRunRecovery;
  tasks: WorkerTaskView[];
}

/** Build a read-only professional view from the canonical project Worker registry. */
export function workerRunViewsFor(
  runs: readonly WorkerRunQueueState[],
  recoveries: readonly WorkerRunRecovery[],
  orchestrationId: string,
  evidenceRecords: readonly EvidenceRecord[] = [],
  sideEffectRecords: readonly SideEffectRecord[] = [],
  cleanupProposals: readonly WorkerCleanupProposal[] = [],
): WorkerRunView[] {
  return runs
    .filter((run) => run.orchestrationId === orchestrationId)
    .map((run) => ({
      runId: run.runId,
      orchestrationId: run.orchestrationId,
      status: run.status,
      updatedAt: run.updatedAt,
      recovery: recoveries.find((item) => item.runId === run.runId),
      tasks: Object.values(run.tasks).map((task) => ({
        taskId: task.taskId,
        status: task.status,
        attempt: task.attempt,
        error: task.error,
        evidenceIds: [...task.evidenceIds],
        evidence: task.evidenceIds.flatMap((id) => {
          const record = evidenceRecords.find((item) => item.id === id);
          return record
            ? [{
                id: record.id,
                kind: record.kind,
                status: record.status,
                command: record.command,
                exitCode: record.exitCode,
                summary: record.summary,
                createdAt: record.createdAt,
              }]
            : [];
        }),
        sideEffects: sideEffectRecords
          .filter((record) => record.runId === run.runId && record.taskId === task.taskId)
          .map((record) => ({
            idempotencyKey: record.idempotencyKey,
            kind: record.kind,
            status: record.status,
            recovery: record.recovery,
            receiptId: record.receipt?.receiptId,
            unknownReason: record.unknownReason,
          })),
        cleanup: cleanupProposals.find((proposal) => proposal.runId === run.runId && proposal.taskId === task.taskId),
        worktreePath: task.worktreePath,
      })),
    }));
}
