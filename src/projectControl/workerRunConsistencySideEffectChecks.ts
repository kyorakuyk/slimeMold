import { pathComparisonKey } from '../dev/path-utils';
import type { SideEffectRecord } from '../domain/contracts';
import { createTaskExecutionId } from '../domain/execution';
import { resolveWorkerAcceptanceStageId } from '../domain/workerQueue';
import { normalizeWorkerSuccessProvenance } from '../domain/workerSuccess';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type {
  ExpectedTaskLineage,
  WorkerRunConsistencyAuditContext,
} from './workerRunConsistencyTypes';
import { isArtifactDeliveryReceiptShape } from './workerDelivery';
import { issue, isVerifiedHistoricalEffect, recordMatchesTaskLineage } from './workerRunConsistencyUtils';

interface SideEffectTaskContext {
  run: WorkerRunQueueState;
  task: WorkerRunQueueState['tasks'][string];
  taskId: string;
  expectedLineage: ExpectedTaskLineage;
  currentLineageMatches: boolean;
}

/** receipt 成功来源校验共用的事实（参数对象，避免长位置参数列表）。 */
interface WorkerReceiptProvenanceContext {
  context: WorkerRunConsistencyAuditContext;
  run: WorkerRunQueueState;
  task: WorkerRunQueueState['tasks'][string];
  taskId: string;
  expectedLineage: ExpectedTaskLineage;
}

export function checkWorkerRunSideEffects(context: WorkerRunConsistencyAuditContext): void {
  if (context.input.sideEffects) {
    for (const effect of context.input.sideEffects) {
      checkWorkerSideEffect(context, effect);
    }
  }
}

function checkWorkerSideEffect(
  context: WorkerRunConsistencyAuditContext,
  effect: SideEffectRecord,
): void {
  const taskContext = prepareSideEffectTaskContext(context, effect);
  if (!taskContext) return;
  if (checkArtifactDeliverySideEffect(context, effect, taskContext)) return;
  checkWorkerOrCleanupSideEffect(context, effect, taskContext);
}

function prepareSideEffectTaskContext(
  context: WorkerRunConsistencyAuditContext,
  effect: SideEffectRecord,
): SideEffectTaskContext | undefined {
  if (!effect.runId || !effect.taskId || !effect.taskExecutionId || !effect.attemptId) {
    context.issues.push(issue(
      'side-effect-lineage-drift',
      `side-effect 缺少完整 Run/Task/Execution/Attempt lineage：${effect.idempotencyKey}`,
      { runId: effect.runId, taskId: effect.taskId },
    ));
    return undefined;
  }
  const effectTaskId = effect.taskId;
  const run = context.runsById.get(effect.runId);
  const task = run?.tasks[effectTaskId];
  if (!run || !task) {
    context.issues.push(issue(
      'side-effect-lineage-drift',
      `side-effect 未绑定 ProjectFile Worker Task：${effect.idempotencyKey}`,
      { runId: effect.runId, taskId: effectTaskId },
    ));
    return undefined;
  }
  const expectedLineage: ExpectedTaskLineage = {
    runId: run.runId,
    taskId: effectTaskId,
    taskExecutionId: task.taskExecutionId ?? createTaskExecutionId(run.runId, effectTaskId),
    currentAttempt: task.pendingAttempt ?? task.attempt,
    explicit: true,
  };
  const currentLineageMatches = recordMatchesTaskLineage(effect, expectedLineage, true);
  if (!currentLineageMatches && isVerifiedHistoricalEffect(effect, expectedLineage)) return undefined;
  if (!currentLineageMatches) {
    context.issues.push(issue(
      'side-effect-lineage-drift',
      `side-effect 未绑定当前 Run/Task/Attempt：${effect.idempotencyKey}`,
      { runId: run.runId, taskId: effectTaskId },
    ));
  }
  return { run, task, taskId: effectTaskId, expectedLineage, currentLineageMatches };
}

function checkArtifactDeliverySideEffect(
  context: WorkerRunConsistencyAuditContext,
  effect: SideEffectRecord,
  taskContext: SideEffectTaskContext,
): boolean {
  const isArtifactDelivery = effect.kind === 'artifact-delivery'
    || effect.idempotencyKey.startsWith('artifact-delivery:');
  if (!isArtifactDelivery) return false;
  const { run, task, taskId, currentLineageMatches } = taskContext;
  const candidateId = effect.idempotencyKey.startsWith('artifact-delivery:')
    ? effect.idempotencyKey.slice('artifact-delivery:'.length)
    : '';
  const acceptance = context.input.acceptances?.find((record) => record.acceptanceId === task.acceptanceId);
  const deliveryReceiptMatches = !!task.acceptanceId
    && !!acceptance
    && acceptance.passed
    && acceptance.failedChecks.length === 0
    && isArtifactDeliveryReceiptShape(effect, {
      candidateId,
      acceptanceId: task.acceptanceId,
    });
  const deliveryUnknownMatches = effect.status === 'unknown'
    && effect.recovery === 'needs-user'
    && effect.receipt === undefined
    && effect.kind === 'artifact-delivery'
    && !!candidateId
    && effect.target.trim().length > 0
    && effect.inputHash.trim().length > 0;
  const deliveryLifecycleMatches = currentLineageMatches
    && (deliveryReceiptMatches || deliveryUnknownMatches);
  if (!deliveryLifecycleMatches) {
    context.issues.push(issue(
      'side-effect-lineage-drift',
      `artifact-delivery receipt 与当前任务不一致：${effect.idempotencyKey}`,
      { runId: run.runId, taskId },
    ));
  }
  return true;
}

function checkWorkerOrCleanupSideEffect(
  context: WorkerRunConsistencyAuditContext,
  effect: SideEffectRecord,
  taskContext: SideEffectTaskContext,
): void {
  const { run, task, taskId, expectedLineage } = taskContext;
  const isCleanup = effect.idempotencyKey.startsWith('cleanup:');
  const expectedTarget = isCleanup ? task.worktreePath : task.worktreeId;
  const expectedInputHash = isCleanup
    ? `${task.baseRevision ?? ''}:${effect.receipt?.outputHash ?? ''}`
    : task.taskDefinitionVersion === 1
      ? task.worktreePath && task.branch
        ? JSON.stringify([
          run.runId,
          taskId,
          task.taskDefinitionVersion,
          task.attempt,
          task.baseRevision,
          task.worktreePath,
          task.branch,
        ])
        : undefined
      : undefined;
  const inputHashMatches = isCleanup && effect.status === 'unknown' && effect.recovery === 'needs-user'
    ? !!task.baseRevision && effect.inputHash.startsWith(`${task.baseRevision}:`)
    : expectedInputHash !== undefined && effect.inputHash === expectedInputHash;
  const receiptContext: WorkerReceiptProvenanceContext = { context, run, task, taskId, expectedLineage };
  const receiptSuccessProvenanceMatches = workerReceiptSuccessProvenanceMatches(receiptContext, effect, isCleanup);
  const lifecycleMatches = effect.kind === (isCleanup ? 'worktree-cleanup' : 'worker-execution')
    && expectedTarget !== undefined
    && effect.target === expectedTarget
    && inputHashMatches
    && receiptSuccessProvenanceMatches
    && (effect.status !== 'receipt'
      || (effect.receipt?.outcome !== undefined && effect.receipt.receiptId === `${effect.idempotencyKey}:receipt`));
  if (!lifecycleMatches) {
    context.issues.push(issue(
      'side-effect-lineage-drift',
      `side-effect kind/target/inputHash/status/receipt 与当前任务不一致：${effect.idempotencyKey}`,
      { runId: run.runId, taskId },
    ));
  }
}

function workerReceiptSuccessProvenanceMatches(
  receiptContext: WorkerReceiptProvenanceContext,
  effect: SideEffectRecord,
  isCleanup: boolean,
): boolean {
  const { task, taskId } = receiptContext;
  let matches = true;
  if (!isCleanup && effect.status === 'receipt' && effect.receipt?.outcome === 'succeeded') {
    try {
      const success = normalizeWorkerSuccessProvenance(effect.receipt.evidenceIds, effect.receipt.acceptanceId);
      const expectedStageId = resolveWorkerAcceptanceStageId(taskId, task.acceptanceStageId);
      const evidenceMatches = workerReceiptEvidenceMatches(receiptContext, success.evidenceIds, expectedStageId);
      const acceptanceMatches = workerReceiptAcceptanceMatches(receiptContext, success.acceptanceId, expectedStageId);
      matches = evidenceMatches && acceptanceMatches;
    } catch {
      matches = false;
    }
  }
  return matches;
}

function workerReceiptEvidenceMatches(
  receiptContext: WorkerReceiptProvenanceContext,
  evidenceIds: readonly string[],
  expectedStageId: string | undefined,
): boolean {
  const { context, run, task, taskId, expectedLineage } = receiptContext;
  return context.input.evidence !== undefined && evidenceIds.every((evidenceId) => {
    const record = context.evidenceById.get(evidenceId);
    return !!record
      && record.capturedBy === 'host'
      && record.status === 'passed'
      && record.orchestrationId === (run.orchestrationId ?? run.runId)
      && record.runId === run.runId
      && record.taskId === taskId
      && record.stageId === expectedStageId
      && (!task.worktreePath
        || (record.worktreePath !== undefined
          && pathComparisonKey(record.worktreePath) === pathComparisonKey(task.worktreePath)))
      && (!task.baseRevision || record.baseRevision === task.baseRevision)
      && recordMatchesTaskLineage(record, expectedLineage, true);
  });
}

function workerReceiptAcceptanceMatches(
  receiptContext: WorkerReceiptProvenanceContext,
  acceptanceId: string,
  expectedStageId: string | undefined,
): boolean {
  const { context, run, task, expectedLineage } = receiptContext;
  return context.input.acceptances !== undefined
    && context.input.acceptances.filter((record) => record.acceptanceId === acceptanceId).length === 1
    && (() => {
      const acceptance = context.input.acceptances!.find((record) => record.acceptanceId === acceptanceId)!;
      return acceptance.passed
        && acceptance.failedChecks.length === 0
        && acceptance.orchestrationId === (run.orchestrationId ?? run.runId)
        && acceptance.stageId === expectedStageId
        && (!task.worktreePath
          || pathComparisonKey(acceptance.worktreePath) === pathComparisonKey(task.worktreePath))
        && recordMatchesTaskLineage(acceptance, expectedLineage, true);
    })();
}
