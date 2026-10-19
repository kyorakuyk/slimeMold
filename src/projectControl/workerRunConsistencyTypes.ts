import type { DomainEvent, DomainProjection, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { EvidenceRecord } from '../dev/evidence';
import type { AcceptanceRecord } from '../dev/session';
import type { ProjectTaskGraph } from './types';

export type WorkerRunConsistencyIssueCode =
  | 'invalid-event-stream'
  | 'event-stream-project-mismatch'
  | 'control-state-drift'
  | 'missing-run-event'
  | 'run-status-drift'
  | 'missing-task-event'
  | 'task-status-drift'
  | 'task-run-drift'
  | 'task-evidence-drift'
  | 'task-acceptance-drift'
  | 'task-cleanup-drift'
  | 'evidence-lineage-drift'
  | 'acceptance-lineage-drift'
  | 'side-effect-lineage-drift'
  | 'task-execution-lineage-drift'
  | 'attempt-lineage-drift'
  | 'missing-attempt-event'
  | 'orphaned-run-event'
  | 'orphaned-task-event'
  | 'task-graph-duplicate'
  | 'task-graph-version-drift'
  | 'task-graph-unapproved';

export interface WorkerRunConsistencyIssue {
  code: WorkerRunConsistencyIssueCode;
  message: string;
  runId?: string;
  taskId?: string;
}

export interface WorkerRunConsistencyReport {
  ok: boolean;
  projection: DomainProjection;
  issues: WorkerRunConsistencyIssue[];
}

export interface WorkerRunConsistencyInput {
  projectId: string;
  runs: readonly WorkerRunQueueState[];
  events: readonly DomainEvent[];
  evidence?: readonly EvidenceRecord[];
  acceptances?: readonly AcceptanceRecord[];
  sideEffects?: readonly SideEffectRecord[];
  taskGraphs?: readonly ProjectTaskGraph[];
}

export interface ExpectedTaskLineage {
  runId: string;
  taskId: string;
  taskExecutionId: string;
  currentAttempt: number;
  explicit: boolean;
}

export interface WorkerRunConsistencyAuditContext {
  input: WorkerRunConsistencyInput;
  projection: DomainProjection;
  issues: WorkerRunConsistencyIssue[];
  evidenceById: Map<string, EvidenceRecord>;
  runsById: Map<string, WorkerRunQueueState>;
  duplicateGraphIds: Set<string>;
}
