import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerQueueTask, WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph, ProjectTask } from './types';

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
    runId: string;
    orchestrationId: string | null;
    taskGraphId: string;
    taskGraphVersion: number;
    status: WorkerRunQueueState['status'];
    tasks: WorkerRecoveryTaskFactV1[];
  };
  taskGraph: {
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

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function comparableWorkerPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requiredText(value, 'string')))].sort();
}

function taskFact(task: WorkerQueueTask): WorkerRecoveryTaskFactV1 {
  return {
    taskId: requiredText(task.taskId, 'task id'),
    ...(task.acceptanceStageId === undefined ? {} : { acceptanceStageId: requiredText(task.acceptanceStageId, 'acceptance stage id') }),
    ...(task.taskDefinitionVersion === undefined ? {} : { taskDefinitionVersion: task.taskDefinitionVersion }),
    ...(task.taskExecutionId === undefined ? {} : { taskExecutionId: requiredText(task.taskExecutionId, 'task execution id') }),
    status: task.status,
    attempt: task.attempt,
    ...(task.pendingAttempt === undefined ? {} : { pendingAttempt: task.pendingAttempt }),
    ...(task.currentAttemptId === undefined ? {} : { currentAttemptId: requiredText(task.currentAttemptId, 'attempt id') }),
    ...(task.worktreeId === undefined ? {} : { worktreeId: requiredText(task.worktreeId, 'worktree id') }),
    ...(task.worktreePath === undefined ? {} : { worktreePath: comparableWorkerPath(task.worktreePath) }),
    ...(task.branch === undefined ? {} : { branch: requiredText(task.branch, 'branch') }),
    ...(task.baseRevision === undefined ? {} : { baseRevision: requiredText(task.baseRevision, 'base revision') }),
    ...(task.worktreeStatus === undefined ? {} : { worktreeStatus: task.worktreeStatus }),
    ...(task.branchRevision === undefined ? {} : { branchRevision: requiredText(task.branchRevision, 'branch revision') }),
    ...(task.cleanupStateSignature === undefined ? {} : { cleanupStateSignature: requiredText(task.cleanupStateSignature, 'cleanup state signature') }),
    evidenceIds: sortedStrings(task.evidenceIds),
    ...(task.contextPackId === undefined ? {} : { contextPackId: requiredText(task.contextPackId, 'context pack id') }),
    ...(task.contextPackVersion === undefined ? {} : { contextPackVersion: task.contextPackVersion }),
    ...(task.feedbackId === undefined ? {} : { feedbackId: requiredText(task.feedbackId, 'feedback id') }),
    ...(task.acceptanceId === undefined ? {} : { acceptanceId: requiredText(task.acceptanceId, 'acceptance id') }),
    ...(task.cleanupStatus === undefined ? {} : { cleanupStatus: task.cleanupStatus }),
    ...(task.cleanupReceiptId === undefined ? {} : { cleanupReceiptId: requiredText(task.cleanupReceiptId, 'cleanup receipt id') }),
    ...(task.error === undefined ? {} : { error: task.error }),
  };
}

function projectTaskFact(task: ProjectTask): WorkerRecoveryProjectTaskFactV1 {
  return {
    version: task.version,
    id: requiredText(task.id, 'task id'),
    architectureId: requiredText(task.architectureId, 'architecture id'),
    ...(task.issueId === undefined ? {} : { issueId: requiredText(task.issueId, 'issue id') }),
    title: task.title,
    description: task.description,
    moduleId: requiredText(task.moduleId, 'module id'),
    scope: [...task.scope],
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: [...task.acceptanceCriteria],
    category: task.category,
    status: task.status,
    ...(task.workflowId === undefined ? {} : { workflowId: requiredText(task.workflowId, 'workflow id') }),
    ...(task.stageId === undefined ? {} : { stageId: requiredText(task.stageId, 'stage id') }),
  };
}

function receiptFact(receipt: NonNullable<SideEffectRecord['receipt']>): WorkerRecoveryEffectFactV1['receipt'] {
  return {
    receiptId: requiredText(receipt.receiptId, 'receipt id'),
    ...(receipt.outputHash === undefined ? {} : { outputHash: receipt.outputHash }),
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(receipt.evidenceIds === undefined ? {} : { evidenceIds: sortedStrings(receipt.evidenceIds) }),
    ...(receipt.acceptanceId === undefined ? {} : { acceptanceId: requiredText(receipt.acceptanceId, 'acceptance id') }),
    ...(receipt.artifactCandidateId === undefined ? {} : { artifactCandidateId: requiredText(receipt.artifactCandidateId, 'artifact candidate id') }),
    ...(receipt.approvalId === undefined ? {} : { approvalId: requiredText(receipt.approvalId, 'approval id') }),
    ...(receipt.files === undefined ? {} : {
      files: receipt.files
        .map((file) => ({ path: comparableWorkerPath(file.path), contentHash: file.contentHash }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  };
}

function effectFact(effect: SideEffectRecord, runId: string): WorkerRecoveryEffectFactV1 {
  if (effect.runId !== runId) {
    throw new Error(`recoverable effect 不属于当前 Worker Run：${effect.idempotencyKey}`);
  }
  if (!effect.taskId || !effect.taskExecutionId || !effect.attemptId) {
    throw new Error(`recoverable effect 缺少完整 lineage：${effect.idempotencyKey}`);
  }
  if (effect.status !== 'started' && effect.status !== 'unknown') {
    throw new Error(`非 recoverable effect 不能进入 facts fingerprint：${effect.idempotencyKey}`);
  }
  if (effect.recovery !== 'retry' && effect.recovery !== 'needs-user') {
    throw new Error(`recoverable effect recovery 状态无效：${effect.idempotencyKey}`);
  }
  return {
    idempotencyKey: requiredText(effect.idempotencyKey, 'idempotency key'),
    kind: requiredText(effect.kind, 'effect kind'),
    target: requiredText(effect.target, 'effect target'),
    inputHash: requiredText(effect.inputHash, 'input hash'),
    runId,
    taskId: requiredText(effect.taskId, 'task id'),
    taskExecutionId: requiredText(effect.taskExecutionId, 'task execution id'),
    attemptId: requiredText(effect.attemptId, 'attempt id'),
    ...(effect.orchestrationId === undefined ? {} : { orchestrationId: requiredText(effect.orchestrationId, 'orchestration id') }),
    ...(effect.acceptanceStageId === undefined ? {} : { acceptanceStageId: requiredText(effect.acceptanceStageId, 'acceptance stage id') }),
    status: effect.status,
    recovery: effect.recovery,
    ...(effect.unknownReason === undefined ? {} : { unknownReason: effect.unknownReason }),
    ...(effect.receipt === undefined ? {} : { receipt: receiptFact(effect.receipt) }),
  };
}

export function buildWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): WorkerRecoveryFactsV1 {
  const projectId = requiredText(input.projectId, 'project id');
  const runId = requiredText(input.run.runId, 'run id');
  if (input.run.projectId !== projectId) throw new Error(`Worker Run 不属于当前 project：${runId}`);
  if (input.taskGraph.id !== input.run.taskGraphId || input.taskGraph.graphVersion !== input.run.taskGraphVersion) {
    throw new Error(`TaskGraph 与 Worker Run 不匹配：${runId}`);
  }

  const tasks = Object.values(input.run.tasks)
    .map(taskFact)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error(`Worker Run task id 重复：${runId}`);
  }
  const graphTasks = input.taskGraph.tasks
    .map(projectTaskFact)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(graphTasks.map((task) => task.id)).size !== graphTasks.length) {
    throw new Error(`TaskGraph task id 重复：${input.taskGraph.id}`);
  }

  const recoverableEffects = input.sideEffects
    .filter((effect) => effect.status === 'started' || effect.status === 'unknown')
    .map((effect) => effectFact(effect, runId))
    .sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
  if (new Set(recoverableEffects.map((effect) => effect.idempotencyKey)).size !== recoverableEffects.length) {
    throw new Error(`recoverable effect idempotency key 重复：${runId}`);
  }

  return {
    schema: WORKER_RECOVERY_FACTS_SCHEMA,
    projectId,
    run: {
      runId,
      orchestrationId: input.run.orchestrationId ?? null,
      taskGraphId: input.run.taskGraphId,
      taskGraphVersion: input.run.taskGraphVersion,
      status: input.run.status,
      tasks,
    },
    taskGraph: {
      id: input.taskGraph.id,
      graphVersion: input.taskGraph.graphVersion,
      sessionId: input.taskGraph.sessionId,
      architectureId: input.taskGraph.architectureId,
      approval: input.taskGraph.approval,
      tasks: graphTasks,
      ...(input.taskGraph.approvedBy === undefined ? {} : { approvedBy: input.taskGraph.approvedBy }),
      ...(input.taskGraph.revisionOf === undefined ? {} : { revisionOf: input.taskGraph.revisionOf }),
      ...(input.taskGraph.supersededBy === undefined ? {} : { supersededBy: input.taskGraph.supersededBy }),
    },
    failedTaskIds: tasks
      .filter((task) => task.status === 'failed' || task.status === 'running')
      .map((task) => task.taskId)
      .sort(),
    recoverableEffects,
  };
}

function canonicalize(value: unknown, inArray = false): string {
  if (value === undefined) {
    if (inArray) throw new Error('canonical facts 不允许 array 中出现 undefined');
    return '';
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical facts 不允许非有限数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, true)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new Error(`canonical facts 类型不支持：${typeof value}`);
}

export function canonicalizeWorkerRecoveryFactsV1(facts: WorkerRecoveryFactsV1): string {
  if (facts.schema !== WORKER_RECOVERY_FACTS_SCHEMA) throw new Error('Worker recovery facts schema 无效');
  return canonicalize(facts);
}

export async function fingerprintWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): Promise<string> {
  const canonical = canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(input));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 recovery facts SHA-256');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `${WORKER_RECOVERY_FACTS_SCHEMA}:sha256:${hex}`;
}
