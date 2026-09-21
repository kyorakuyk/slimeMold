import type { SideEffectRecord } from '../domain/contracts';
import { assertTaskExecutionLineage, assertTaskExecutionId, createTaskExecutionId, parseAttemptId } from '../domain/execution';
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

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  if (normalized !== value) throw new Error(`${field} 必须使用 canonical 形式，不能包含首尾空白`);
  return value;
}

function safeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} 必须是合法 safe integer：${value}`);
  return value;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalPath(value: string, field: string): string {
  const text = requiredText(value, field);
  if (text.includes('\\') || text.split('/').some((segment, index) => (index > 0 && segment === '') || segment === '.' || segment === '..')) {
    throw new Error(`${field} 不是 canonical path`);
  }
  if (text.endsWith('/') && !/^[A-Za-z]:\/$/.test(text) && !text.startsWith('//')) throw new Error(`${field} 不能以 / 结尾`);
  return text;
}

function comparableWorkerPath(value: string): string {
  const normalized = canonicalPath(value, 'path');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}
function canonicalRef(value: string, field: string): string {
  const text = requiredText(value, field);
  const components = text.split('/');
  if (!/^[A-Za-z0-9._/-]+$/.test(text)
    || text.includes('..')
    || text.includes('@{')
    || text.startsWith('/')
    || text.endsWith('/')
    || components.some((component) => !component || component.startsWith('.') || component.endsWith('.') || component.endsWith('.lock'))) {
    throw new Error(`${field} 不是 canonical Git ref`);
  }
  return text;
}

function canonicalTimestamp(value: string, field: string): string {
  const text = requiredText(value, field);
  if (new Date(text).toISOString() !== text) throw new Error(`${field} 不是 canonical timestamp`);
  return text;
}

function canonicalRevision(value: string, field: string): string {
  const text = requiredText(value, field);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new Error(`${field} 不是 canonical revision`);
  return text;
}

function uniqueStringsPreserveOrder(values: readonly string[], field: string): string[] {
  const normalized = values.map((value) => requiredText(value, field));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} 不允许重复 reference`);
  return [...normalized];
}

function sortedStrings(values: readonly string[]): string[] {
  const normalized = values.map((value) => requiredText(value, 'string'));
  if (new Set(normalized).size !== normalized.length) throw new Error('canonical facts 不允许重复 reference');
  return [...normalized].sort(compareUtf8);
}

function taskFact(task: WorkerQueueTask, runId: string): WorkerRecoveryTaskFactV1 {
  const taskId = requiredText(task.taskId, 'task id');
  const taskStatuses = new Set(['queued', 'running', 'waiting-feedback', 'succeeded', 'failed', 'blocked', 'cancelled']);
  if (task.taskDefinitionVersion !== undefined && task.taskDefinitionVersion !== 1) {
    throw new Error(`taskDefinitionVersion 无效：${task.taskDefinitionVersion}`);
  }
  if (task.worktreeStatus !== undefined && !new Set(['created', 'cleaned', 'orphaned', 'registration-pending']).has(task.worktreeStatus)) {
    throw new Error(`worktreeStatus 无效：${task.worktreeStatus}`);
  }
  if (task.cleanupStatus !== undefined && task.cleanupStatus !== 'cleaned') {
    throw new Error(`cleanupStatus 无效：${task.cleanupStatus}`);
  }
  if (!taskStatuses.has(task.status)) throw new Error(`task status 无效：${task.status}`);
  safeInteger(task.attempt, 'attempt');

  if (task.pendingAttempt !== undefined) {
    safeInteger(task.pendingAttempt, 'pendingAttempt', 1);
    if (task.status !== 'queued' || task.pendingAttempt !== task.attempt + 1 || task.currentAttemptId !== undefined) {
      throw new Error(`pendingAttempt fence 无效：${taskId}`);
    }
  }
  if (task.contextPackVersion !== undefined) safeInteger(task.contextPackVersion, 'contextPackVersion');
  const assignmentFields = [task.worktreeId, task.worktreePath, task.branch, task.baseRevision];
  const assignmentCount = assignmentFields.filter((value) => value !== undefined).length;
  if (assignmentCount !== 0 && assignmentCount !== assignmentFields.length) {
    throw new Error(`WorkerTask assignment 不完整：${taskId}`);
  }
  if (['created', 'orphaned', 'registration-pending'].includes(task.worktreeStatus ?? '')
    && (assignmentCount !== assignmentFields.length || task.branchRevision === undefined)) {
    throw new Error(`assigned worktree state 缺少完整 provenance：${taskId}`);
  }
  if (task.cleanupStatus === 'cleaned'
    && (task.status !== 'succeeded' || task.worktreeStatus !== 'cleaned' || task.cleanupReceiptId === undefined)) {
    throw new Error(`cleanupStatus 与 task/worktree/receipt 不一致：${taskId}`);
  }
  if (task.worktreeStatus === 'cleaned'
    && (task.cleanupStatus !== 'cleaned' || task.cleanupReceiptId === undefined)) {
    throw new Error(`cleaned worktree 缺少 cleanup receipt：${taskId}`);
  }
  if (task.status === 'running' && task.attempt < 1) throw new Error(`running task attempt 无效：${taskId}`);
  if (task.worktreePath !== undefined) canonicalPath(task.worktreePath, 'worktree path');
  if (task.branch !== undefined) canonicalRef(task.branch, 'branch');
  if (task.baseRevision !== undefined) canonicalRevision(task.baseRevision, 'baseRevision');
  if (task.branchRevision !== undefined) canonicalRevision(task.branchRevision, 'branchRevision');
  if (task.worktreeId !== undefined) requiredText(task.worktreeId, 'worktree id');
  if (task.attempt > 0 && (task.taskExecutionId === undefined || task.currentAttemptId === undefined)) {
    throw new Error(`attempt > 0 的 task 缺少 current attempt lineage：${taskId}`);
  }
  if (task.taskExecutionId !== undefined) {
    const taskExecutionId = requiredText(task.taskExecutionId, 'task execution id');
    assertTaskExecutionId(taskExecutionId);
    if (taskExecutionId !== createTaskExecutionId(runId, taskId)) {
      throw new Error(`taskExecutionId 与 runId/taskId 不一致：${taskId}`);
    }
  }
  if (task.currentAttemptId !== undefined) {
    assertTaskExecutionLineage({
      runId,
      taskId,
      taskExecutionId: task.taskExecutionId,
      attemptId: requiredText(task.currentAttemptId, 'attempt id'),
      attempt: task.attempt,
    });
  }
  canonicalTimestamp(task.updatedAt, 'WorkerTask updatedAt');
  return {
    taskId,
    ...(task.acceptanceStageId === undefined ? {} : { acceptanceStageId: requiredText(task.acceptanceStageId, 'acceptance stage id') }),
    ...(task.taskDefinitionVersion === undefined ? {} : { taskDefinitionVersion: task.taskDefinitionVersion }),
    ...(task.taskExecutionId === undefined ? {} : { taskExecutionId: requiredText(task.taskExecutionId, 'task execution id') }),
    status: task.status,
    attempt: task.attempt,
    ...(task.pendingAttempt === undefined ? {} : { pendingAttempt: task.pendingAttempt }),
    ...(task.currentAttemptId === undefined ? {} : { currentAttemptId: requiredText(task.currentAttemptId, 'attempt id') }),
    ...(task.worktreeId === undefined ? {} : { worktreeId: requiredText(task.worktreeId, 'worktree id') }),
    ...(task.worktreePath === undefined ? {} : { worktreePath: comparableWorkerPath(task.worktreePath) }),
    ...(task.branch === undefined ? {} : { branch: canonicalRef(task.branch, 'branch') }),
    ...(task.baseRevision === undefined ? {} : { baseRevision: canonicalRevision(task.baseRevision, 'base revision') }),
    ...(task.worktreeStatus === undefined ? {} : { worktreeStatus: task.worktreeStatus }),
    ...(task.branchRevision === undefined ? {} : { branchRevision: canonicalRevision(task.branchRevision, 'branch revision') }),
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
  if (task.version !== 1) throw new Error(`task definition version 不受支持：${task.version}`);
  const taskStatuses = new Set(['proposed', 'approved', 'queued', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
  if (!taskStatuses.has(task.status)) throw new Error(`ProjectTask status 无效：${task.status}`);
  canonicalTimestamp(task.createdAt, 'ProjectTask createdAt');
  canonicalTimestamp(task.updatedAt, 'ProjectTask updatedAt');
  const scope = task.scope.map((path) => comparableWorkerPath(canonicalPath(path, 'task scope path'))).sort(compareUtf8);
  if (new Set(scope).size !== scope.length) throw new Error(`ProjectTask scope path 重复：${task.id}`);
  const dependsOn = sortedStrings(task.dependsOn);
  const acceptanceCriteria = uniqueStringsPreserveOrder(task.acceptanceCriteria, 'acceptance criterion');
  return {
    version: task.version,
    id: requiredText(task.id, 'task id'),
    architectureId: requiredText(task.architectureId, 'architecture id'),
    ...(task.issueId === undefined ? {} : { issueId: requiredText(task.issueId, 'issue id') }),
    title: task.title,
    description: task.description,
    moduleId: requiredText(task.moduleId, 'module id'),
    scope,
    dependsOn,
    acceptanceCriteria,
    category: task.category,
    status: task.status,
    ...(task.workflowId === undefined ? {} : { workflowId: requiredText(task.workflowId, 'workflow id') }),
    ...(task.stageId === undefined ? {} : { stageId: requiredText(task.stageId, 'stage id') }),
  };
}

function receiptFact(receipt: NonNullable<SideEffectRecord['receipt']>): WorkerRecoveryEffectFactV1['receipt'] {
  if (typeof receipt !== 'object' || receipt === null) throw new Error('receipt 必须是对象');
  assertKeys(receipt as unknown as Record<string, unknown>, ['receiptId', 'observedAt', 'outputHash', 'outcome', 'evidenceIds', 'acceptanceId', 'artifactCandidateId', 'approvalId', 'files', 'error'], 'receipt');
  if (receipt.outcome !== undefined && receipt.outcome !== 'succeeded' && receipt.outcome !== 'failed') {
    throw new Error(`receipt outcome 无效：${receipt.outcome}`);
  }
  if (receipt.evidenceIds !== undefined && !Array.isArray(receipt.evidenceIds)) throw new Error('receipt evidenceIds 必须是数组');
  if (receipt.files !== undefined && !Array.isArray(receipt.files)) throw new Error('receipt files 必须是数组');
  requiredText(receipt.receiptId, 'receipt id');
  canonicalTimestamp(receipt.observedAt, 'receipt observedAt');
  const evidenceIds = receipt.evidenceIds === undefined ? undefined : sortedStrings(receipt.evidenceIds);
  const files = receipt.files === undefined ? undefined : receipt.files
    .map((file) => {
      assertKeys(assertObject(file, 'receipt file'), ['path', 'contentHash'], 'receipt file');
      return { path: comparableWorkerPath(requiredText(file.path, 'receipt file path')), contentHash: requiredText(file.contentHash, 'receipt file hash') };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  if (files && new Set(files.map((file) => file.path)).size !== files.length) throw new Error('receipt files 不允许重复 path');
  return {
    receiptId: requiredText(receipt.receiptId, 'receipt id'),
    ...(receipt.outputHash === undefined ? {} : { outputHash: requiredText(receipt.outputHash, 'receipt output hash') }),
    ...(receipt.outcome === undefined ? {} : { outcome: receipt.outcome }),
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
    ...(receipt.acceptanceId === undefined ? {} : { acceptanceId: requiredText(receipt.acceptanceId, 'acceptance id') }),
    ...(receipt.artifactCandidateId === undefined ? {} : { artifactCandidateId: requiredText(receipt.artifactCandidateId, 'artifact candidate id') }),
    ...(receipt.approvalId === undefined ? {} : { approvalId: requiredText(receipt.approvalId, 'approval id') }),
    ...(files === undefined ? {} : { files }),
    ...(receipt.error === undefined ? {} : { error: requiredText(receipt.error, 'receipt error') }),
  };
}

function validateSideEffectEnvelope(effect: SideEffectRecord): void {
  const idempotencyKey = requiredText(effect.idempotencyKey ?? '', 'effect idempotency key');
  const kind = requiredText(effect.kind ?? '', 'effect kind');
  if (kind !== 'worker-execution' && kind !== 'worktree-cleanup') throw new Error(`effect kind 无效：${idempotencyKey}`);
  requiredText(effect.target ?? '', 'effect target');
  requiredText(effect.inputHash ?? '', 'effect inputHash');
  const effectRunId = requiredText(effect.runId ?? '', 'effect run id');
  const effectTaskId = requiredText(effect.taskId ?? '', 'effect task id');
  const taskExecutionId = assertTaskExecutionId(requiredText(effect.taskExecutionId ?? '', 'effect task execution id'));
  if (taskExecutionId !== createTaskExecutionId(effectRunId, effectTaskId)) throw new Error(`effect execution lineage 不一致：${idempotencyKey}`);
  const parsedAttempt = parseAttemptId(requiredText(effect.attemptId ?? '', 'effect attempt id'));
  if (parsedAttempt.taskExecutionId !== taskExecutionId) throw new Error(`effect attempt lineage 不一致：${idempotencyKey}`);
  const statuses = new Set(['planned', 'started', 'receipt', 'unknown']);
  const recoveries = new Set(['retry', 'skip', 'needs-user']);
  if (!statuses.has(effect.status)) throw new Error(`side effect status 无效：${effect.idempotencyKey}`);
  if (!recoveries.has(effect.recovery)) throw new Error(`side effect recovery 无效：${effect.idempotencyKey}`);
  if (effect.status === 'planned' && effect.recovery !== 'retry') throw new Error(`planned effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'started' && effect.recovery !== 'retry') throw new Error(`started effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'unknown' && effect.recovery !== 'needs-user') throw new Error(`unknown effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'unknown') requiredText(effect.unknownReason ?? '', 'unknownReason');
  if (effect.unknownReason !== undefined) requiredText(effect.unknownReason, 'unknownReason');
  if (effect.status === 'receipt') {
    if (effect.recovery !== 'skip' || !effect.receipt || !effect.receipt.outcome) throw new Error(`receipt effect receipt/recovery/outcome 不一致：${effect.idempotencyKey}`);
    receiptFact(effect.receipt);
  } else if (effect.receipt !== undefined) {
    throw new Error(`非 receipt effect 不能携带 receipt：${effect.idempotencyKey}`);
  }
}

function effectFact(
  effect: SideEffectRecord,
  runId: string,
  runTasks: Readonly<Record<string, WorkerQueueTask>>,
  graphTasks: ReadonlyMap<string, ProjectTask>,
): WorkerRecoveryEffectFactV1 {
  if (effect.runId !== runId) {
    throw new Error(`recoverable effect 不属于当前 Worker Run：${effect.idempotencyKey}`);
  }
  const taskId = requiredText(effect.taskId ?? '', 'task id');
  const task = runTasks[taskId];
  const graphTask = graphTasks.get(taskId);
  if (!task || !graphTask) throw new Error(`recoverable effect 绑定了不存在的 task：${effect.idempotencyKey}`);
  if (effect.taskExecutionId === undefined || effect.attemptId === undefined) {
    throw new Error(`recoverable effect 缺少完整 lineage：${effect.idempotencyKey}`);
  }
  const taskExecutionId = requiredText(effect.taskExecutionId, 'task execution id');
  const attemptId = requiredText(effect.attemptId, 'attempt id');
  const parsed = assertTaskExecutionLineage({
    runId,
    taskId,
    taskExecutionId,
    attemptId,
    attempt: task.attempt,
  });
  if (task.taskExecutionId === undefined || task.currentAttemptId === undefined) {
    throw new Error(`当前 task 缺少完整 current attempt lineage：${taskId}`);
  }
  if (task.taskExecutionId !== taskExecutionId) {
    throw new Error(`recoverable effect taskExecutionId 不属于当前 task：${effect.idempotencyKey}`);
  }
  if (task.currentAttemptId !== attemptId) {
    throw new Error(`recoverable effect attemptId 不属于当前 attempt：${effect.idempotencyKey}`);
  }
  const target = requiredText(effect.target, 'effect target');
  if (effect.kind === 'worktree-cleanup') {
    if (!task.worktreePath || !task.baseRevision || !task.cleanupStateSignature) {
      throw new Error(`cleanup effect 缺少 assignment provenance：${effect.idempotencyKey}`);
    }
    if (comparableWorkerPath(target) !== comparableWorkerPath(task.worktreePath)) {
      throw new Error(`cleanup effect target 与当前 worktree 不匹配：${effect.idempotencyKey}`);
    }
    if (effect.inputHash !== `${task.baseRevision}:${task.cleanupStateSignature}`) {
      throw new Error(`cleanup effect signature 不匹配：${effect.idempotencyKey}`);
    }
  } else {
    if (effect.kind !== 'worker-execution') throw new Error(`recoverable effect kind 无效：${effect.idempotencyKey}`);
    if (!task.worktreeId || !task.worktreePath || !task.branch || !task.baseRevision) {
      throw new Error(`recoverable effect 缺少 assignment provenance：${effect.idempotencyKey}`);
    }
    if (target !== task.worktreeId) {
      throw new Error(`recoverable effect target 与当前 worktree 不匹配：${effect.idempotencyKey}`);
    }
    let inputHash: unknown;
    try {
      inputHash = JSON.parse(effect.inputHash);
    } catch {
      throw new Error(`recoverable effect inputHash 无法解析：${effect.idempotencyKey}`);
    }
    if (!Array.isArray(inputHash) || inputHash.length !== 7) {
      throw new Error(`recoverable effect inputHash 缺少 7 元 provenance：${effect.idempotencyKey}`);
    }
    if (
      inputHash[0] !== runId
      || inputHash[1] !== taskId
      || inputHash[2] !== graphTask.version
      || inputHash[3] !== parsed.attempt
      || inputHash[4] !== task.baseRevision
      || typeof inputHash[5] !== 'string'
      || comparableWorkerPath(inputHash[5]) !== comparableWorkerPath(task.worktreePath)
      || inputHash[6] !== task.branch
      || JSON.stringify(inputHash) !== effect.inputHash
    ) {
      throw new Error(`recoverable effect inputHash provenance 不匹配：${effect.idempotencyKey}`);
    }
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
    taskId,
    taskExecutionId,
    attemptId,
    ...(effect.orchestrationId === undefined ? {} : { orchestrationId: requiredText(effect.orchestrationId, 'orchestration id') }),
    ...(effect.acceptanceStageId === undefined ? {} : { acceptanceStageId: requiredText(effect.acceptanceStageId, 'acceptance stage id') }),
    status: effect.status,
    recovery: effect.recovery,
    ...(effect.unknownReason === undefined ? {} : { unknownReason: effect.unknownReason }),
    ...(effect.receipt === undefined ? {} : { receipt: receiptFact(effect.receipt) }),
  };
}

export function buildWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): WorkerRecoveryFactsV1 {
  if (input.run.version !== 1) throw new Error(`Worker Run version 不受支持：${input.run.version}`);
  if (input.taskGraph.version !== 1) throw new Error(`TaskGraph version 不受支持：${input.taskGraph.version}`);
  canonicalTimestamp(input.run.createdAt, 'WorkerRun createdAt');
  canonicalTimestamp(input.run.updatedAt, 'WorkerRun updatedAt');
  canonicalTimestamp(input.taskGraph.createdAt, 'TaskGraph createdAt');
  canonicalTimestamp(input.taskGraph.updatedAt, 'TaskGraph updatedAt');
  const projectId = requiredText(input.projectId, 'project id');
  const runId = requiredText(input.run.runId, 'run id');
  const taskGraphId = requiredText(input.run.taskGraphId, 'taskGraph id');
  const graphId = requiredText(input.taskGraph.id, 'TaskGraph id');
  requiredText(input.taskGraph.sessionId, 'session id');
  requiredText(input.taskGraph.architectureId, 'architecture id');
  const taskGraphVersion = safeInteger(input.run.taskGraphVersion, 'taskGraphVersion');
  const graphVersion = safeInteger(input.taskGraph.graphVersion, 'graphVersion');
  const runStatuses = new Set(['queued', 'running', 'partial', 'blocked', 'failed', 'cancelled', 'succeeded']);
  if (!runStatuses.has(input.run.status)) throw new Error(`Worker Run status 无效：${input.run.status}`);
  if (!new Set(['draft', 'approved', 'superseded']).has(input.taskGraph.approval)) {
    throw new Error(`TaskGraph approval 无效：${input.taskGraph.approval}`);
  }
  if (input.taskGraph.approval === 'approved') canonicalTimestamp(input.taskGraph.approvedAt ?? '', 'TaskGraph approvedAt');
  if (input.taskGraph.approvedAt !== undefined) canonicalTimestamp(input.taskGraph.approvedAt, 'TaskGraph approvedAt');
  if (input.taskGraph.approvedBy !== undefined) requiredText(input.taskGraph.approvedBy, 'approvedBy');
  if (input.run.projectId !== projectId) throw new Error(`Worker Run 不属于当前 project：${runId}`);
  if (graphId !== taskGraphId || graphVersion !== taskGraphVersion) {
    throw new Error(`TaskGraph 与 Worker Run 不匹配：${runId}`);
  }

  const tasks = Object.entries(input.run.tasks)
    .map(([key, task]) => {
      if (key !== task.taskId) throw new Error(`Worker Run task map key 与 taskId 不一致：${key}`);
      return taskFact(task, runId);
    })
    .sort((left, right) => compareUtf8(left.taskId, right.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error(`Worker Run task id 重复：${runId}`);
  }
  const graphTasks = input.taskGraph.tasks
    .map(projectTaskFact)
    .sort((left, right) => compareUtf8(left.id, right.id));
  if (new Set(graphTasks.map((task) => task.id)).size !== graphTasks.length) {
    throw new Error(`TaskGraph task id 重复：${input.taskGraph.id}`);
  }
  const graphTaskIds = new Set(graphTasks.map((task) => task.id));
  for (const task of graphTasks) {
    for (const dependencyId of task.dependsOn) {
      if (!graphTaskIds.has(dependencyId)) throw new Error(`TaskGraph dependency 不存在：${task.id} -> ${dependencyId}`);
    }
  }
  if (graphTaskIds.size === 0 || graphTaskIds.size !== tasks.length) throw new Error(`Worker Run/TaskGraph task set 不完整：${runId}`);
  for (const task of tasks) {
    if (!graphTaskIds.has(task.taskId)) throw new Error(`Worker Run task 不存在于 TaskGraph：${task.taskId}`);
  }
  const graphTasksById = new Map(input.taskGraph.tasks.map((task) => [task.id, task]));
  const allEffectKeys = input.sideEffects.map((effect) => requiredText(effect.idempotencyKey, 'effect idempotency key'));
  if (new Set(allEffectKeys).size !== allEffectKeys.length) throw new Error(`side effect idempotency key 重复：${runId}`);
  for (const effect of input.sideEffects) validateSideEffectEnvelope(effect);

  const recoverableEffects = input.sideEffects
    .filter((effect) => effect.status === 'started' || effect.status === 'unknown')
    .map((effect) => effectFact(effect, runId, input.run.tasks, graphTasksById))
    .sort((left, right) => compareUtf8(left.idempotencyKey, right.idempotencyKey));
  if (new Set(recoverableEffects.map((effect) => effect.idempotencyKey)).size !== recoverableEffects.length) {
    throw new Error(`recoverable effect idempotency key 重复：${runId}`);
  }

  return {
    schema: WORKER_RECOVERY_FACTS_SCHEMA,
    projectId,
    run: {
      version: 1,
      runId,
      orchestrationId: input.run.orchestrationId ?? null,
      taskGraphId,
      taskGraphVersion,
      status: input.run.status,
      tasks,
    },
    taskGraph: {
      version: 1,
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
      .sort(compareUtf8),
    recoverableEffects,
  };
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new Error(`${field} 包含未知字段：${key}`);
}

function validateFactsDto(facts: WorkerRecoveryFactsV1): void {
  const root = assertObject(facts, 'facts');
  assertKeys(root, ['schema', 'projectId', 'run', 'taskGraph', 'failedTaskIds', 'recoverableEffects'], 'facts');
  if (facts.schema !== WORKER_RECOVERY_FACTS_SCHEMA) throw new Error('Worker recovery facts schema 无效');
  requiredText(facts.projectId, 'project id');
  const run = assertObject(facts.run, 'facts.run');
  assertKeys(run, ['version', 'runId', 'orchestrationId', 'taskGraphId', 'taskGraphVersion', 'status', 'tasks'], 'facts.run');
  if (facts.run.version !== 1) throw new Error('facts.run version 无效');
  if (!new Set(['queued', 'running', 'partial', 'blocked', 'failed', 'cancelled', 'succeeded']).has(facts.run.status)) throw new Error('facts.run status 无效');
  requiredText(facts.run.runId, 'facts.run runId');
  if (facts.run.orchestrationId !== null) requiredText(facts.run.orchestrationId, 'facts.run orchestrationId');
  requiredText(facts.run.taskGraphId, 'facts.run taskGraphId');
  safeInteger(facts.run.taskGraphVersion, 'facts.run taskGraphVersion');
  if (!Array.isArray(facts.run.tasks)) throw new Error('facts.run tasks 必须是数组');
  const taskIds = new Set<string>();
  for (const task of facts.run.tasks) {
    const record = assertObject(task, 'facts.run task');
    assertKeys(record, ['taskId', 'acceptanceStageId', 'taskDefinitionVersion', 'taskExecutionId', 'status', 'attempt', 'pendingAttempt', 'currentAttemptId', 'worktreeId', 'worktreePath', 'branch', 'baseRevision', 'worktreeStatus', 'branchRevision', 'cleanupStateSignature', 'evidenceIds', 'contextPackId', 'contextPackVersion', 'feedbackId', 'acceptanceId', 'cleanupStatus', 'cleanupReceiptId', 'error'], 'facts.run task');
    requiredText(task.taskId, 'facts task id');
    if (taskIds.has(task.taskId)) throw new Error('facts task id 重复');
    taskIds.add(task.taskId);
    safeInteger(task.attempt, 'facts task attempt');
    if (!new Set(['queued', 'running', 'waiting-feedback', 'succeeded', 'failed', 'blocked', 'cancelled']).has(task.status)) throw new Error('facts task status 无效');
    if (task.cleanupStatus !== undefined && task.cleanupStatus !== 'cleaned') throw new Error('facts cleanupStatus 无效');
    if (task.worktreeStatus !== undefined && !new Set(['created', 'cleaned', 'orphaned', 'registration-pending']).has(task.worktreeStatus)) throw new Error('facts worktreeStatus 无效');
    if (task.taskDefinitionVersion !== undefined && task.taskDefinitionVersion !== 1) throw new Error('facts taskDefinitionVersion 无效');
    if (task.taskExecutionId !== undefined) {
      const taskExecutionId = assertTaskExecutionId(task.taskExecutionId);
      if (taskExecutionId !== createTaskExecutionId(facts.run.runId, task.taskId)) throw new Error('facts taskExecutionId lineage 无效');
    }
    if (task.attempt > 0 && (task.taskExecutionId === undefined || task.currentAttemptId === undefined)) throw new Error('facts task current lineage 缺失');
    if (task.currentAttemptId !== undefined) {
      assertTaskExecutionLineage({ runId: facts.run.runId, taskId: task.taskId, taskExecutionId: task.taskExecutionId, attemptId: task.currentAttemptId, attempt: task.attempt });
    }
    const assignmentFields = [task.worktreeId, task.worktreePath, task.branch, task.baseRevision];
    const assignmentCount = assignmentFields.filter((value) => value !== undefined).length;
    if (assignmentCount !== 0 && assignmentCount !== assignmentFields.length) throw new Error('facts task assignment 不完整');
    if (['created', 'orphaned', 'registration-pending'].includes(task.worktreeStatus ?? '')
      && (assignmentCount !== assignmentFields.length || task.branchRevision === undefined)) throw new Error('facts assigned worktree provenance 不完整');
    if (task.worktreeStatus !== undefined && !new Set(['created', 'cleaned', 'orphaned', 'registration-pending']).has(task.worktreeStatus)) throw new Error('facts worktreeStatus 无效');
    if (task.worktreePath !== undefined) comparableWorkerPath(task.worktreePath);
    if (task.branch !== undefined) canonicalRef(task.branch, 'facts task branch');
    if (task.baseRevision !== undefined) canonicalRevision(task.baseRevision, 'facts task baseRevision');
    if (task.branchRevision !== undefined) canonicalRevision(task.branchRevision, 'facts task branchRevision');
    if (task.pendingAttempt !== undefined && (task.status !== 'queued' || task.pendingAttempt !== task.attempt + 1 || task.currentAttemptId !== undefined)) throw new Error('facts pendingAttempt fence 无效');
    if (task.cleanupStatus === 'cleaned' && (task.status !== 'succeeded' || task.worktreeStatus !== 'cleaned' || task.cleanupReceiptId === undefined)) throw new Error('facts cleanup invariant 无效');
    if (task.worktreeStatus === 'cleaned' && (task.cleanupStatus !== 'cleaned' || task.cleanupReceiptId === undefined)) throw new Error('facts cleaned worktree invariant 无效');
    if (task.worktreeId !== undefined) requiredText(task.worktreeId, 'facts task worktreeId');
    if (task.cleanupStateSignature !== undefined) requiredText(task.cleanupStateSignature, 'facts task cleanupStateSignature');
    if (task.contextPackId !== undefined) requiredText(task.contextPackId, 'facts task contextPackId');
    if (task.feedbackId !== undefined) requiredText(task.feedbackId, 'facts task feedbackId');
    if (task.acceptanceId !== undefined) requiredText(task.acceptanceId, 'facts task acceptanceId');
    if (task.cleanupReceiptId !== undefined) requiredText(task.cleanupReceiptId, 'facts task cleanupReceiptId');
    if (task.error !== undefined) requiredText(task.error, 'facts task error');
    sortedStrings(task.evidenceIds);
  }
  const graph = assertObject(facts.taskGraph, 'facts.taskGraph');
  assertKeys(graph, ['version', 'id', 'graphVersion', 'sessionId', 'architectureId', 'approval', 'tasks', 'approvedBy', 'revisionOf', 'supersededBy'], 'facts.taskGraph');
  if (facts.taskGraph.version !== 1) throw new Error('facts.taskGraph version 无效');
  if (!new Set(['draft', 'approved', 'superseded']).has(facts.taskGraph.approval)) throw new Error('facts.taskGraph approval 无效');
  requiredText(facts.taskGraph.id, 'facts graph id');
  safeInteger(facts.taskGraph.graphVersion, 'facts graphVersion');
  if (!Array.isArray(facts.taskGraph.tasks)) throw new Error('facts graph tasks 必须是数组');
  const graphIds = new Set<string>();
  for (const task of facts.taskGraph.tasks) {
    const record = assertObject(task, 'facts graph task');
    assertKeys(record, ['version', 'id', 'architectureId', 'issueId', 'title', 'description', 'moduleId', 'scope', 'dependsOn', 'acceptanceCriteria', 'category', 'status', 'workflowId', 'stageId'], 'facts graph task');
    requiredText(task.id, 'facts graph task id');
    if (graphIds.has(task.id)) throw new Error('facts graph task id 重复');
    graphIds.add(task.id);
    if (task.version !== 1) throw new Error('facts graph task version 无效');
    if (!new Set(['proposed', 'approved', 'queued', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).has(task.status)) throw new Error('facts graph task status 无效');
    if (!Array.isArray(task.scope) || !Array.isArray(task.dependsOn) || !Array.isArray(task.acceptanceCriteria)) throw new Error('facts graph task references 必须是数组');
    const scope = task.scope.map((path) => comparableWorkerPath(path));
    if (new Set(scope).size !== scope.length) throw new Error('facts graph task scope 重复');
    sortedStrings(task.dependsOn);
    uniqueStringsPreserveOrder(task.acceptanceCriteria, 'facts acceptance criterion');
  }
  for (const task of facts.taskGraph.tasks) {
    for (const dependencyId of task.dependsOn) if (!graphIds.has(dependencyId)) throw new Error('facts graph dependency 不存在');
  }
  const runTaskIds = new Set(taskIds);
  if (facts.taskGraph.id !== facts.run.taskGraphId || facts.taskGraph.graphVersion !== facts.run.taskGraphVersion) throw new Error('facts run/graph identity 不一致');
  if (graphIds.size === 0 || graphIds.size !== runTaskIds.size || [...graphIds].some((id) => !runTaskIds.has(id))) throw new Error('facts run/graph task set 不一致');
  if (!Array.isArray(facts.failedTaskIds) || !Array.isArray(facts.recoverableEffects)) throw new Error('facts recovery arrays 无效');
  sortedStrings(facts.failedTaskIds);
  const effectIds = new Set<string>();
  for (const effect of facts.recoverableEffects) {
    const record = assertObject(effect, 'facts effect');
    assertKeys(record, ['idempotencyKey', 'kind', 'target', 'inputHash', 'runId', 'taskId', 'taskExecutionId', 'attemptId', 'orchestrationId', 'acceptanceStageId', 'status', 'recovery', 'unknownReason', 'receipt'], 'facts effect');
    requiredText(effect.idempotencyKey, 'facts effect idempotencyKey');
    if (effectIds.has(effect.idempotencyKey)) throw new Error('facts effect idempotencyKey 重复');
    effectIds.add(effect.idempotencyKey);
    const currentTask = facts.run.tasks.find((task) => task.taskId === effect.taskId);
    const graphTask = facts.taskGraph.tasks.find((task) => task.id === effect.taskId);
    if (!currentTask || !graphTask) throw new Error('facts effect task 不存在于 snapshot');
    if (effect.runId !== facts.run.runId) throw new Error('facts effect runId 不匹配');
    if (effect.taskId !== currentTask.taskId) throw new Error('facts effect taskId 不匹配');
    const kind = requiredText(effect.kind, 'facts effect kind');
    if (kind !== 'worker-execution' && kind !== 'worktree-cleanup') throw new Error('facts effect kind 无效');
    requiredText(effect.target, 'facts effect target');
    requiredText(effect.inputHash, 'facts effect inputHash');
    const effectRunId = requiredText(effect.runId, 'facts effect runId');
    const effectTaskId = requiredText(effect.taskId, 'facts effect taskId');
    const parsedExecutionId = assertTaskExecutionId(requiredText(effect.taskExecutionId, 'facts effect taskExecutionId'));
    if (parsedExecutionId !== createTaskExecutionId(effectRunId, effectTaskId)) throw new Error('facts effect lineage 无效');
    const parsedAttempt = parseAttemptId(requiredText(effect.attemptId, 'facts effect attemptId'));
    if (parsedExecutionId !== currentTask.taskExecutionId || parsedAttempt.taskExecutionId !== parsedExecutionId || parsedAttempt.attempt !== currentTask.attempt || effect.attemptId !== currentTask.currentAttemptId) throw new Error('facts effect current attempt lineage 无效');
    if (effect.status !== 'started' && effect.status !== 'unknown') throw new Error('facts effect status 无效');
    if (effect.status === 'started' && effect.recovery !== 'retry') throw new Error('facts started lifecycle 无效');
    if (effect.status === 'unknown' && effect.recovery !== 'needs-user') throw new Error('facts unknown lifecycle 无效');
    if (kind === 'worktree-cleanup') {
      if (!currentTask.worktreePath || !currentTask.baseRevision || !currentTask.cleanupStateSignature
        || comparableWorkerPath(effect.target) !== comparableWorkerPath(currentTask.worktreePath)
        || effect.inputHash !== `${currentTask.baseRevision}:${currentTask.cleanupStateSignature}`) throw new Error('facts cleanup effect provenance 无效');
    } else {
      if (!currentTask.worktreeId || !currentTask.worktreePath || !currentTask.branch || !currentTask.baseRevision || effect.target !== currentTask.worktreeId) throw new Error('facts worker effect assignment 无效');
      let inputHash: unknown;
      try { inputHash = JSON.parse(effect.inputHash); } catch { throw new Error('facts worker effect inputHash 无效'); }
      if (!Array.isArray(inputHash) || inputHash.length !== 7
        || inputHash[0] !== facts.run.runId
        || inputHash[1] !== currentTask.taskId
        || inputHash[2] !== graphTask.version
        || inputHash[3] !== currentTask.attempt
        || inputHash[4] !== currentTask.baseRevision
        || typeof inputHash[5] !== 'string'
        || comparableWorkerPath(inputHash[5]) !== comparableWorkerPath(currentTask.worktreePath)
        || inputHash[6] !== currentTask.branch
        || JSON.stringify(inputHash) !== effect.inputHash) throw new Error('facts worker effect inputHash provenance 无效');
    }

    if (effect.recovery !== 'retry' && effect.recovery !== 'needs-user') throw new Error('facts effect recovery 无效');
    if (effect.receipt !== undefined) throw new Error('facts recoverable effect 不应携带 receipt');
    if (effect.status === 'unknown') requiredText(effect.unknownReason ?? '', 'facts effect unknownReason');
  }
}

function normalizeFactsDto(facts: WorkerRecoveryFactsV1): WorkerRecoveryFactsV1 {
  return {
    ...facts,
    run: {
      ...facts.run,
      tasks: facts.run.tasks
        .map((task) => ({
          ...task,
          ...(task.worktreePath === undefined ? {} : { worktreePath: comparableWorkerPath(task.worktreePath) }),
          evidenceIds: sortedStrings(task.evidenceIds),
        }))
        .sort((left, right) => compareUtf8(left.taskId, right.taskId)),
    },
    taskGraph: {
      ...facts.taskGraph,
      tasks: facts.taskGraph.tasks
        .map((task) => ({
          ...task,
          scope: task.scope.map((path) => comparableWorkerPath(path)).sort(compareUtf8),
          dependsOn: sortedStrings(task.dependsOn),
          acceptanceCriteria: [...task.acceptanceCriteria],
        }))
        .sort((left, right) => compareUtf8(left.id, right.id)),
    },
    failedTaskIds: sortedStrings(facts.failedTaskIds),
    recoverableEffects: facts.recoverableEffects
      .map((effect) => {
        let target = effect.target;
        let inputHash = effect.inputHash;
        if (effect.kind === 'worktree-cleanup') {
          target = comparableWorkerPath(target);
        } else {
          const tuple = JSON.parse(inputHash) as unknown[];
          tuple[5] = comparableWorkerPath(String(tuple[5]));
          inputHash = JSON.stringify(tuple);
        }
        return {
          ...effect,
          target,
          inputHash,
          ...(effect.receipt === undefined ? {} : {
            receipt: {
              ...effect.receipt,
              ...(effect.receipt.evidenceIds === undefined ? {} : { evidenceIds: sortedStrings(effect.receipt.evidenceIds) }),
              ...(effect.receipt.files === undefined ? {} : { files: [...effect.receipt.files].map((file) => ({ ...file, path: comparableWorkerPath(file.path) })).sort((left, right) => compareUtf8(left.path, right.path)) }),
            },
          }),
        };
      })
      .sort((left, right) => compareUtf8(left.idempotencyKey, right.idempotencyKey)),
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
    if (!Number.isSafeInteger(value)) throw new Error('canonical facts 只允许 safe integer 数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, true)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new Error(`canonical facts 类型不支持：${typeof value}`);
}

export function canonicalizeWorkerRecoveryFactsV1(facts: WorkerRecoveryFactsV1): string {
  validateFactsDto(facts);
  const normalized = normalizeFactsDto(facts);
  validateFactsDto(normalized);
  return canonicalize(normalized);
}

export async function fingerprintWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): Promise<string> {
  const canonical = canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(input));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 recovery facts SHA-256');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `${WORKER_RECOVERY_FACTS_SCHEMA}:sha256:${hex}`;
}
