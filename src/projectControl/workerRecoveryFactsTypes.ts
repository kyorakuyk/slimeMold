import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerQueueTask, WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTask, ProjectTaskGraph } from './types';

export const WORKER_RECOVERY_FACTS_SCHEMA = 'worker-recovery-facts-v1' as const;
export type WorkerRecoveryFactsSchema = typeof WORKER_RECOVERY_FACTS_SCHEMA;

export interface WorkerRecoveryTaskFactV1 {
  taskId: string;
  acceptanceStageId?: string;
  taskDefinitionVersion?: 1;
  taskExecutionId?: string;
  status: WorkerQueueTask['status'];
  attempt: number;
  pendingAttempt?: number;
  currentAttemptId?: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  baseRevision?: string;
  worktreeStatus?: WorkerQueueTask['worktreeStatus'];
  branchRevision?: string;
  cleanupStateSignature?: string;
  evidenceIds: string[];
  contextPackId?: string;
  contextPackVersion?: number;
  feedbackId?: string;
  acceptanceId?: string;
  cleanupStatus?: 'cleaned';
  cleanupReceiptId?: string;
  error?: string;
}

export interface WorkerRecoveryProjectTaskFactV1 {
  version: ProjectTask['version'];
  id: string;
  architectureId: string;
  issueId?: string;
  title: string;
  description: string;
  moduleId: string;
  scope: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  category: ProjectTask['category'];
  status: ProjectTask['status'];
  workflowId?: string;
  stageId?: string;
}

export interface WorkerRecoveryEffectFactV1 {
  idempotencyKey: string;
  kind: string;
  target: string;
  inputHash: string;
  runId: string;
  taskId: string;
  taskExecutionId: string;
  attemptId: string;
  orchestrationId?: string;
  acceptanceStageId?: string;
  status: 'started' | 'unknown';
  recovery: 'retry' | 'needs-user';
  unknownReason?: string;
  receipt?: {
    receiptId: string;
    outputHash?: string;
    outcome?: 'succeeded' | 'failed';
    evidenceIds?: string[];
    acceptanceId?: string;
    artifactCandidateId?: string;
    approvalId?: string;
    files?: Array<{ path: string; contentHash: string }>;
    error?: string;
  };
}

export interface WorkerRecoveryFactsV1 {
  schema: WorkerRecoveryFactsSchema;
  projectId: string;
  run: {
    version: 1;
    runId: string;
    orchestrationId: string | null;
    taskGraphId: string;
    taskGraphVersion: number;
    status: WorkerRunQueueState['status'];
    tasks: WorkerRecoveryTaskFactV1[];
  };
  taskGraph: {
    version: 1;
    id: string;
    graphVersion: number;
    sessionId: string;
    architectureId: string;
    approval: ProjectTaskGraph['approval'];
    tasks: WorkerRecoveryProjectTaskFactV1[];
    approvedBy?: string;
    revisionOf?: string;
    supersededBy?: string;
  };
  failedTaskIds: string[];
  recoverableEffects: WorkerRecoveryEffectFactV1[];
}

export interface WorkerRecoveryFactsInput {
  projectId: string;
  run: WorkerRunQueueState;
  taskGraph: ProjectTaskGraph;
  sideEffects: readonly SideEffectRecord[];
}
