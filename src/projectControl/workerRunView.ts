import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from './workerCleanup';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

export interface WorkerEvidenceView {
  id: string;
  kind: EvidenceRecord['kind'];
  status: EvidenceRecord['status'];
  command?: string;
  exitCode?: number;
  summary: string;
  createdAt: string;
  taskExecutionId?: string;
  attemptId?: string;
}

export interface WorkerSideEffectView {
  idempotencyKey: string;
  kind: string;
  status: SideEffectRecord['status'];
  recovery?: SideEffectRecord['recovery'];
  receiptId?: string;
  unknownReason?: string;
  taskExecutionId?: string;
  attemptId?: string;
}

export interface WorkerTaskView {
  taskId: string;
  taskExecutionId: string;
  attemptId?: string;
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
      tasks: Object.values(run.tasks).map((task) => {
        const taskExecutionId = task.taskExecutionId ?? createTaskExecutionId(run.runId, task.taskId);
        const hasActiveAttempt = task.status === 'running'
          || task.status === 'failed'
          || task.status === 'succeeded';
        const attemptId = task.attempt > 0 && hasActiveAttempt
          ? task.currentAttemptId ?? createAttemptId(taskExecutionId, task.attempt)
          : undefined;
        const taskHasExplicitLineage = Boolean(task.taskExecutionId || task.currentAttemptId);
        const recordMatchesLineage = (record: {
          taskExecutionId?: string;
          attemptId?: string;
        }): boolean => (
          (!taskHasExplicitLineage && !record.taskExecutionId && !record.attemptId)
          || (record.taskExecutionId === taskExecutionId && record.attemptId === attemptId)
        );
        return {
          taskId: task.taskId,
          taskExecutionId,
          attemptId,
          status: task.status,
          attempt: task.attempt,
          error: task.error,
          evidenceIds: [...task.evidenceIds],
          evidence: task.evidenceIds.flatMap((id) => {
            const record = evidenceRecords.find((item) => item.id === id && recordMatchesLineage(item));
            return record
              ? [{
                id: record.id,
                kind: record.kind,
                status: record.status,
                command: record.command,
                exitCode: record.exitCode,
                summary: record.summary,
                createdAt: record.createdAt,
                taskExecutionId: record.taskExecutionId,
                attemptId: record.attemptId,
              }]
              : [];
          }),
          sideEffects: sideEffectRecords
            .filter((record) => record.runId === run.runId && record.taskId === task.taskId)
            .filter(recordMatchesLineage)
            .map((record) => ({
            idempotencyKey: record.idempotencyKey,
            kind: record.kind,
            status: record.status,
            recovery: record.recovery,
            receiptId: record.receipt?.receiptId,
            unknownReason: record.unknownReason,
            taskExecutionId: record.taskExecutionId,
            attemptId: record.attemptId,
          })),
          cleanup: cleanupProposals.find((proposal) => (
            proposal.runId === run.runId
            && proposal.taskId === task.taskId
            && (!taskHasExplicitLineage
              || ('taskExecutionId' in proposal
                && 'attemptId' in proposal
                && proposal.taskExecutionId === taskExecutionId
                && proposal.attemptId === attemptId))
          )),
          worktreePath: task.worktreePath,
        };
      }),
    }));
}
