import type { SideEffectRecord } from '../domain/contracts';
import { assertTaskExecutionLineage, assertTaskExecutionId, createTaskExecutionId, parseAttemptId } from '../domain/execution';
import type { WorkerQueueTask } from '../domain/workerQueue';
import type { ProjectTask } from './types';

import {
  WORKER_RECOVERY_FACTS_SCHEMA,
} from './workerRecoveryFactsTypes';
import type {
  WorkerRecoveryEffectFactV1,
  WorkerRecoveryFactsInput,
  WorkerRecoveryFactsV1,
  WorkerRecoveryProjectTaskFactV1,
  WorkerRecoveryTaskFactV1,
} from './workerRecoveryFactsTypes';

export { WORKER_RECOVERY_FACTS_SCHEMA } from './workerRecoveryFactsTypes';
export type {
  WorkerRecoveryEffectFactV1,
  WorkerRecoveryFactsInput,
  WorkerRecoveryFactsSchema,
  WorkerRecoveryFactsV1,
  WorkerRecoveryProjectTaskFactV1,
  WorkerRecoveryTaskFactV1,
} from './workerRecoveryFactsTypes';

import {
  assertKeys,
  assertObject,
  assertTaskAttemptInvariant,
  canonicalPath,
  canonicalRef,
  canonicalRevision,
  canonicalTimestamp,
  comparableWorkerPath,
  compareUtf8,
  requiredText,
  safeInteger,
  sortedStrings,
  uniqueStringsPreserveOrder,
} from './workerRecoveryFactsRules';
import { normalizeFactsDto } from './workerRecoveryFactsNormalization';
import { canonicalizeJsonValue } from './workerRecoveryFactsCanonicalJson';
import { validateFactsDto } from './workerRecoveryFactsDtoValidation';

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
  assertTaskAttemptInvariant(task.status, task.attempt, `Worker Task ${taskId}`);

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
  const receiptObject = assertObject(receipt, 'receipt');
  assertKeys(receiptObject, ['receiptId', 'observedAt', 'outputHash', 'outcome', 'evidenceIds', 'acceptanceId', 'artifactCandidateId', 'approvalId', 'files', 'error'], 'receipt');
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

export function canonicalizeWorkerRecoveryFactsV1(facts: WorkerRecoveryFactsV1): string {
  validateFactsDto(facts);
  const normalized = normalizeFactsDto(facts);
  validateFactsDto(normalized);
  return canonicalizeJsonValue(normalized);
}

export async function fingerprintWorkerRecoveryFactsV1(input: WorkerRecoveryFactsInput): Promise<string> {
  const canonical = canonicalizeWorkerRecoveryFactsV1(buildWorkerRecoveryFactsV1(input));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 recovery facts SHA-256');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `${WORKER_RECOVERY_FACTS_SCHEMA}:sha256:${hex}`;
}
