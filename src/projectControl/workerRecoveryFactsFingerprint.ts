import type { SideEffectRecord } from '../domain/contracts';
import { assertTaskExecutionLineage, assertTaskExecutionId, createTaskExecutionId } from '../domain/execution';
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

function comparableWorkerPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
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

  if (task.pendingAttempt !== undefined) safeInteger(task.pendingAttempt, 'pendingAttempt', 1);
  if (task.contextPackVersion !== undefined) safeInteger(task.contextPackVersion, 'contextPackVersion');
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
    ...(task.worktreePath === undefined ? {} : { worktreePath: comparableWorkerPath(requiredText(task.worktreePath, 'worktree path')) }),
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
  safeInteger(task.version, 'task definition version', 1);
  const taskStatuses = new Set(['proposed', 'approved', 'queued', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
  if (!taskStatuses.has(task.status)) throw new Error(`ProjectTask status 无效：${task.status}`);
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
        .map((file) => ({ path: comparableWorkerPath(requiredText(file.path, 'receipt file path')), contentHash: requiredText(file.contentHash, 'receipt file hash') }))
        .sort((left, right) => compareUtf8(left.path, right.path)),
    }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  };
}

function validateSideEffectEnvelope(effect: SideEffectRecord): void {
  const statuses = new Set(['planned', 'started', 'receipt', 'unknown']);
  const recoveries = new Set(['retry', 'skip', 'needs-user']);
  if (!statuses.has(effect.status)) throw new Error(`side effect status 无效：${effect.idempotencyKey}`);
  if (!recoveries.has(effect.recovery)) throw new Error(`side effect recovery 无效：${effect.idempotencyKey}`);
  if (effect.status === 'planned' && effect.recovery !== 'retry') throw new Error(`planned effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'started' && effect.recovery !== 'retry') throw new Error(`started effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'unknown' && effect.recovery !== 'needs-user') throw new Error(`unknown effect recovery 不一致：${effect.idempotencyKey}`);
  if (effect.status === 'receipt') {
    if (effect.recovery !== 'skip' || !effect.receipt) throw new Error(`receipt effect receipt/recovery 不一致：${effect.idempotencyKey}`);
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
  if (task.taskExecutionId !== undefined && task.taskExecutionId !== taskExecutionId) {
    throw new Error(`recoverable effect taskExecutionId 不属于当前 task：${effect.idempotencyKey}`);
  }
  if (task.currentAttemptId !== undefined && task.currentAttemptId !== attemptId) {
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
  for (const task of tasks) {
    if (!graphTaskIds.has(task.taskId)) throw new Error(`Worker Run task 不存在于 TaskGraph：${task.taskId}`);
  }
  const graphTasksById = new Map(input.taskGraph.tasks.map((task) => [task.id, task]));
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
      runId,
      orchestrationId: input.run.orchestrationId ?? null,
      taskGraphId,
      taskGraphVersion,
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
      .sort(compareUtf8),
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
      .sort(([left], [right]) => compareUtf8(left, right));
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
