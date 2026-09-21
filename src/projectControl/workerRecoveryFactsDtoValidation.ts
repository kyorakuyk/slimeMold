import {
  assertTaskExecutionId,
  assertTaskExecutionLineage,
  createTaskExecutionId,
  parseAttemptId,
} from '../domain/execution';
import {
  assertKeys,
  assertObject,
  assertTaskAttemptInvariant,
  canonicalRef,
  canonicalRevision,
  comparableWorkerPath,
  compareUtf8,
  requiredText,
  safeInteger,
  sortedStrings,
  stringValue,
  uniqueStringsPreserveOrder,
} from './workerRecoveryFactsRules';
import {
  WORKER_RECOVERY_FACTS_SCHEMA,
} from './workerRecoveryFactsTypes';
import type { WorkerRecoveryFactsV1 } from './workerRecoveryFactsTypes';

export function validateFactsDto(facts: WorkerRecoveryFactsV1): void {
  const root = assertObject(facts, 'facts');
  assertKeys(root, ['schema', 'projectId', 'run', 'taskGraph', 'failedTaskIds', 'recoverableEffects'], 'facts');
  if (facts.schema !== WORKER_RECOVERY_FACTS_SCHEMA) throw new Error('Worker recovery facts schema 无效');
  requiredText(facts.projectId, 'project id');
  const run = assertObject(facts.run, 'facts.run');
  assertKeys(run, ['version', 'runId', 'orchestrationId', 'taskGraphId', 'taskGraphVersion', 'status', 'tasks'], 'facts.run');
  if (facts.run.version !== 1) throw new Error('facts.run version 无效');
  if (!new Set(['queued', 'running', 'partial', 'blocked', 'failed', 'cancelled', 'succeeded']).has(facts.run.status)) throw new Error('facts.run status 无效');
  requiredText(facts.run.runId, 'facts.run runId');
  if (facts.run.orchestrationId !== null) stringValue(facts.run.orchestrationId, 'facts.run orchestrationId');
  requiredText(facts.run.taskGraphId, 'facts.run taskGraphId');
  safeInteger(facts.run.taskGraphVersion, 'facts taskGraphVersion');
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
    assertTaskAttemptInvariant(task.status, task.attempt, `facts task ${task.taskId}`);
    if (task.cleanupStatus !== undefined && task.cleanupStatus !== 'cleaned') throw new Error('facts cleanupStatus 无效');
    if (task.worktreeStatus !== undefined && !new Set(['created', 'cleaned', 'orphaned', 'registration-pending']).has(task.worktreeStatus)) throw new Error('facts worktreeStatus 无效');
    if (task.acceptanceStageId !== undefined) stringValue(task.acceptanceStageId, 'facts task acceptanceStageId');
    if (task.contextPackVersion !== undefined) safeInteger(task.contextPackVersion, 'facts task contextPackVersion');
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
  stringValue(facts.taskGraph.sessionId, 'facts graph sessionId');
  stringValue(facts.taskGraph.architectureId, 'facts graph architectureId');
  if (facts.taskGraph.approvedBy !== undefined) stringValue(facts.taskGraph.approvedBy, 'facts graph approvedBy');
  if (facts.taskGraph.revisionOf !== undefined) stringValue(facts.taskGraph.revisionOf, 'facts graph revisionOf');
  if (facts.taskGraph.supersededBy !== undefined) stringValue(facts.taskGraph.supersededBy, 'facts graph supersededBy');
  safeInteger(facts.taskGraph.graphVersion, 'facts graphVersion');
  if (!Array.isArray(facts.taskGraph.tasks)) throw new Error('facts graph tasks 必须是数组');
  const graphIds = new Set<string>();
  for (const task of facts.taskGraph.tasks) {
    const record = assertObject(task, 'facts graph task');
    assertKeys(record, ['version', 'id', 'architectureId', 'issueId', 'title', 'description', 'moduleId', 'scope', 'dependsOn', 'acceptanceCriteria', 'category', 'status', 'workflowId', 'stageId'], 'facts graph task');
    requiredText(task.id, 'facts graph task id');
    stringValue(task.architectureId, 'facts graph task architectureId');
    stringValue(task.title, 'facts graph task title');
    stringValue(task.description, 'facts graph task description');
    stringValue(task.moduleId, 'facts graph task moduleId');
    stringValue(task.category, 'facts graph task category');
    if (task.issueId !== undefined) stringValue(task.issueId, 'facts graph task issueId');
    if (task.workflowId !== undefined) stringValue(task.workflowId, 'facts graph task workflowId');
    if (task.stageId !== undefined) stringValue(task.stageId, 'facts graph task stageId');
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
  const expectedFailedTaskIds = facts.run.tasks
    .filter((task) => task.status === 'failed' || task.status === 'running')
    .map((task) => task.taskId)
    .sort(compareUtf8);
  const actualFailedTaskIds = sortedStrings(facts.failedTaskIds);
  if (actualFailedTaskIds.length !== expectedFailedTaskIds.length
    || actualFailedTaskIds.some((taskId, index) => taskId !== expectedFailedTaskIds[index])) {
    throw new Error('facts failedTaskIds 与 task status 不一致');
  }
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
    if (effect.orchestrationId !== undefined) stringValue(effect.orchestrationId, 'facts effect orchestrationId');
    if (effect.acceptanceStageId !== undefined) stringValue(effect.acceptanceStageId, 'facts effect acceptanceStageId');
    if (effect.unknownReason !== undefined) stringValue(effect.unknownReason, 'facts effect unknownReason');
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
