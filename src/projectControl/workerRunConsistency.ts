import {
  replayDomainEvents,
  type DomainEvent,
  type DomainProjection,
  type SideEffectRecord,
} from '../domain/contracts';
import { resolveWorkerAcceptanceStageId, type WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { EvidenceRecord } from '../dev/evidence';
import type { AcceptanceRecord } from '../dev/session';
import { pathComparisonKey } from '../dev/path-utils';

import { assertTaskExecutionLineage, createAttemptId, createTaskExecutionId, parseAttemptId } from '../domain/execution';
import { hasWorkerSuccessProvenance } from '../domain/workerSuccess';
import { workerCleanupEffectKey } from './workerCleanup';
import { isArtifactDeliveryReceiptShape } from './workerDelivery';

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

function emptyProjection(): DomainProjection {
  return { lastSequence: 0, runs: {}, tasks: {}, taskExecutions: {}, attempts: {} };
}

function issue(
  code: WorkerRunConsistencyIssueCode,
  message: string,
  identifiers: { runId?: string; taskId?: string } = {},
): WorkerRunConsistencyIssue {
  return { code, message, ...identifiers };
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return [...new Set(left ?? [])].sort().join('\u0000') === [...new Set(right ?? [])].sort().join('\u0000');
}

interface ExpectedTaskLineage {
  runId: string;
  taskId: string;
  taskExecutionId: string;
  currentAttempt: number;
  explicit: boolean;
}

function recordMatchesTaskLineage(
  record: {
    runId?: string;
    taskId?: string;
    taskExecutionId?: string;
    attemptId?: string;
  },
  expected: ExpectedTaskLineage,
  currentOnly: boolean,
): boolean {
  const declaresLineage = record.runId !== undefined
    || record.taskId !== undefined
    || record.taskExecutionId !== undefined
    || record.attemptId !== undefined;
  if (!declaresLineage) return false;
  if (!record.runId || !record.taskId || !record.taskExecutionId || !record.attemptId) return false;
  if (record.runId !== expected.runId || record.taskId !== expected.taskId) return false;
  try {
    const parsed = assertTaskExecutionLineage({
      runId: expected.runId,
      taskId: expected.taskId,
      taskExecutionId: record.taskExecutionId,
      attemptId: record.attemptId,
    });
    return currentOnly ? parsed.attempt === expected.currentAttempt : parsed.attempt <= expected.currentAttempt;
  } catch {
    return false;
  }
}

function isVerifiedHistoricalEffect(
  effect: SideEffectRecord,
  expected: ExpectedTaskLineage,
): boolean {
  if (effect.runId !== expected.runId || effect.taskId !== expected.taskId || effect.taskExecutionId !== expected.taskExecutionId) return false;
  if (!effect.attemptId) return false;
  let parsed: ReturnType<typeof parseAttemptId>;
  try {
    parsed = parseAttemptId(effect.attemptId);
  } catch {
    return false;
  }
  if (parsed.taskExecutionId !== expected.taskExecutionId || parsed.attempt >= expected.currentAttempt) return false;
  const expectedAttemptId = createAttemptId(expected.taskExecutionId, parsed.attempt);
  if (effect.attemptId !== expectedAttemptId) return false;
  const isCleanup = effect.idempotencyKey === workerCleanupEffectKey(expected.taskExecutionId, expectedAttemptId);
  const expectedWorkerKey = `worker-execution:${expected.taskExecutionId}:attempt-${parsed.attempt}`;
  const expectedLegacyWorkerKey = `worker-execution:${expected.runId}:${expected.taskId}:attempt-${parsed.attempt}`;
  if (isCleanup) {
    if (effect.kind !== 'worktree-cleanup' || !effect.target || !effect.inputHash.trim()) return false;
  } else if (
    (effect.idempotencyKey !== expectedWorkerKey && effect.idempotencyKey !== expectedLegacyWorkerKey)
    || effect.kind !== 'worker-execution'
  ) {
    return false;
  } else {
    let hash: unknown;
    try { hash = JSON.parse(effect.inputHash); } catch { return false; }
    if (!Array.isArray(hash) || hash[0] !== expected.runId || hash[1] !== expected.taskId || hash[2] !== 1 || hash[3] !== parsed.attempt || typeof hash[4] !== 'string' || !hash[4]) return false;
    if (effect.idempotencyKey === expectedWorkerKey) {
      if (
        hash.length !== 7
        || typeof hash[5] !== 'string'
        || !hash[5]
        || typeof hash[6] !== 'string'
        || !hash[6]
      ) return false;
    } else if (hash.length !== 5) {
      return false;
    }
  }
  if (effect.status === 'unknown') return effect.recovery === 'needs-user' && effect.receipt === undefined;
  return effect.status === 'receipt'
    && effect.recovery === 'skip'
    && effect.receipt?.outcome !== undefined
    && effect.receipt.receiptId === `${effect.idempotencyKey}:receipt`
    && (isCleanup ? effect.inputHash.endsWith(`:${effect.receipt.outputHash ?? ''}`) : true);
}

/**
 * Compare the persisted Worker registry with the durable Worker facts.
 *
 * The event stream is authoritative for audit purposes, but this function does
 * not silently repair either side: any mismatch is returned to the caller so
 * startup/execution can remain fail-closed and surface recovery UI.
 */
export function auditWorkerRunConsistency(input: {
  projectId: string;
  runs: readonly WorkerRunQueueState[];
  events: readonly DomainEvent[];
  evidence?: readonly EvidenceRecord[];
  acceptances?: readonly AcceptanceRecord[];
  sideEffects?: readonly SideEffectRecord[];
  taskGraphs?: readonly ProjectTaskGraph[];
}): WorkerRunConsistencyReport {
  const issues: WorkerRunConsistencyIssue[] = [];
  if (input.runs.length > 0 && input.evidence === undefined) {
    issues.push(issue('evidence-lineage-drift', 'Worker Evidence 尚未加载，拒绝在不完整事实上通过审计'));
  }
  if (
    input.runs.some((run) => Object.values(run.tasks).some((task) => !!task.acceptanceId))
    && input.acceptances === undefined
  ) {
    issues.push(issue('acceptance-lineage-drift', 'Worker Acceptance 尚未加载，拒绝在不完整事实上通过审计'));
  }
  const projectEvents = input.events.filter((event) => event.streamId === input.projectId);
  if (projectEvents.length !== input.events.length) {
    issues.push(issue(
      'event-stream-project-mismatch',
      '事件流包含不属于当前项目的 Worker 事实，拒绝静默混合',
    ));
  }

  let projection = emptyProjection();
  try {
    projection = replayDomainEvents(projectEvents);
  } catch (cause) {
    issues.push(issue(
      'invalid-event-stream',
      `Worker 事件流无法重放：${cause instanceof Error ? cause.message : String(cause)}`,
    ));
    return { ok: false, projection, issues };
  }

  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const graphIds = new Set<string>();
  const duplicateGraphIds = new Set<string>();
  for (const graph of input.taskGraphs ?? []) {
    if (graphIds.has(graph.id)) duplicateGraphIds.add(graph.id);
    graphIds.add(graph.id);
  }
  for (const run of input.runs) {
    if (duplicateGraphIds.has(run.taskGraphId)) {
      issues.push(issue(
        'task-graph-duplicate',
        `Worker Run 关联的 TaskGraph id 重复，拒绝审计：${run.taskGraphId}`,
        { runId: run.runId },
      ));
    }
    const taskGraph = input.taskGraphs?.find((graph) => graph.id === run.taskGraphId);
    if (input.taskGraphs !== undefined && !taskGraph) {
      issues.push(issue(
        'acceptance-lineage-drift',
        `Worker Run 缺少可信 TaskGraph：${run.taskGraphId}`,
        { runId: run.runId },
      ));
    }
    const graphVersionMatches = taskGraph?.graphVersion === run.taskGraphVersion;
    if (taskGraph && !graphVersionMatches) {
      issues.push(issue(
        'task-graph-version-drift',
        `Worker Run 的 TaskGraph version 不匹配：${run.taskGraphId}`,
        { runId: run.runId },
      ));
    }
    if (taskGraph && taskGraph.approval !== 'approved') {
      issues.push(issue(
        'task-graph-unapproved',
        `Worker Run 关联的 TaskGraph 未获批准：${run.taskGraphId}`,
        { runId: run.runId },
      ));
    }
    const replayedRun = projection.runs[run.runId];
    if (!replayedRun) {
      issues.push(issue(
        'missing-run-event',
        `ProjectFile 中存在 Worker Run，但事件流没有对应事实：${run.runId}`,
        { runId: run.runId },
      ));
    } else if (replayedRun.status !== run.status) {
      issues.push(issue(
        'run-status-drift',
        `Worker Run 状态与事件重放不一致：${run.runId}（ProjectFile=${run.status}，events=${replayedRun.status}）`,
        { runId: run.runId },
      ));
    }

    for (const [taskId, task] of Object.entries(run.tasks)) {
      const trustedGraph = taskGraph && graphVersionMatches && taskGraph.approval === 'approved'
        ? taskGraph
        : undefined;
      const taskDefinition = trustedGraph?.tasks.find((item) => item.id === taskId);
      const expectedAcceptanceStageId = input.taskGraphs === undefined
        ? task.acceptanceStageId === undefined
          ? resolveWorkerAcceptanceStageId(taskId, undefined)
          : undefined
        : taskDefinition
          ? resolveWorkerAcceptanceStageId(taskId, taskDefinition.stageId)
          : undefined;
      const persistedAcceptanceStageId = task.acceptanceStageId === undefined
        ? undefined
        : resolveWorkerAcceptanceStageId(taskId, task.acceptanceStageId);
      if (!expectedAcceptanceStageId) {
        issues.push(issue(
          'acceptance-lineage-drift',
          `Worker Task acceptance stage 无效：${taskId}`,
          { runId: run.runId, taskId },
        ));
      } else if (persistedAcceptanceStageId !== undefined
        && persistedAcceptanceStageId !== expectedAcceptanceStageId) {
        issues.push(issue(
          'acceptance-lineage-drift',
          `Worker Task acceptance stage 与可信 TaskGraph 不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      const expectedTaskExecutionId = createTaskExecutionId(run.runId, taskId);
      if (task.taskExecutionId && task.taskExecutionId !== expectedTaskExecutionId) {
        issues.push(issue(
          'task-execution-lineage-drift',
          `Worker Task 的 taskExecutionId 与 Run/Task 定义不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      const taskExecutionId = task.taskExecutionId ?? expectedTaskExecutionId;
      const expectedLineage: ExpectedTaskLineage = {
        runId: run.runId,
        taskId,
        taskExecutionId,
        currentAttempt: task.attempt,
        explicit: Boolean(task.taskExecutionId || task.currentAttemptId),
      };
      const replayedExecution = projection.taskExecutions[taskExecutionId];
      const replayedTask = replayedExecution ?? projection.tasks[taskId];
      if (!replayedTask || (replayedTask.runId && replayedTask.runId !== run.runId)) {
        issues.push(issue(
          'missing-task-event',
          `ProjectFile 中存在 Worker Task，但事件流没有对应事实：${taskId}`,
          { runId: run.runId, taskId },
        ));
        continue;
      }
      if (replayedExecution && (
        replayedExecution.taskExecutionId !== taskExecutionId
        || replayedExecution.taskId !== taskId
        || replayedExecution.runId !== run.runId
      )) {
        issues.push(issue(
          'task-execution-lineage-drift',
          `Worker Task execution lineage 与事件重放不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      if (replayedTask.status !== task.status) {
        issues.push(issue(
          'task-status-drift',
          `Worker Task 状态与事件重放不一致：${taskId}（ProjectFile=${task.status}，events=${replayedTask.status}）`,
          { runId: run.runId, taskId },
        ));
      }
      if (replayedTask.runId && replayedTask.runId !== run.runId) {
        issues.push(issue(
          'task-run-drift',
          `Worker Task 所属 Run 与事件重放不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      if (task.evidenceIds.length > 0 || replayedTask.evidenceIds !== undefined) {
        if (!sameStringSet(task.evidenceIds, replayedTask.evidenceIds)) {
          issues.push(issue(
            'task-evidence-drift',
            `Worker Task Evidence 与事件重放不一致：${taskId}`,
            { runId: run.runId, taskId },
          ));
        }
      }
      if (task.acceptanceId !== replayedTask.acceptanceId) {
        issues.push(issue(
          'task-acceptance-drift',
          `Worker Task acceptanceId 与事件重放不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      const persistedCleaned = task.cleanupStatus === 'cleaned';
      const replayedCleaned = replayedTask.cleanupStatus === 'cleaned';
      if (
        persistedCleaned !== replayedCleaned
        || (persistedCleaned && task.cleanupReceiptId !== replayedTask.cleanupReceiptId)
      ) {
        issues.push(issue(
          'task-cleanup-drift',
          `Worker Task cleanup 状态或 receipt 与事件重放不一致：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }

      if (task.attempt > 0) {
        const expectedAttemptId = task.currentAttemptId ?? createAttemptId(taskExecutionId, task.attempt);
        const replayedAttempt = projection.attempts[expectedAttemptId];
        if (!replayedAttempt) {
          issues.push(issue(
            'missing-attempt-event',
            `ProjectFile 中存在 Worker Attempt，但事件流没有对应事实：${taskId}/a${task.attempt}`,
            { runId: run.runId, taskId },
          ));
        } else if (
          replayedAttempt.taskExecutionId !== taskExecutionId
          || replayedAttempt.taskId !== taskId
          || replayedAttempt.runId !== run.runId
          || replayedAttempt.attempt !== task.attempt
        ) {
          issues.push(issue(
            'attempt-lineage-drift',
            `Worker Attempt lineage 与事件重放不一致：${taskId}/a${task.attempt}`,
            { runId: run.runId, taskId },
          ));
        }
        if (task.currentAttemptId && replayedExecution?.currentAttemptId !== task.currentAttemptId) {
          issues.push(issue(
            'attempt-lineage-drift',
            `Worker Task 当前 Attempt 与事件重放不一致：${taskId}`,
            { runId: run.runId, taskId },
          ));
        }
      }

      if (input.evidence) {
        const evidenceById = new Map(input.evidence.map((record) => [record.id, record]));
        for (const evidenceId of task.evidenceIds) {
          const record = evidenceById.get(evidenceId);
          const expectedOrchestrationId = run.orchestrationId ?? run.runId;
          const evidenceScopeMatches = !!record
            && record.capturedBy === 'host'
            && record.orchestrationId === expectedOrchestrationId
            && record.stageId === expectedAcceptanceStageId
            && (!task.worktreePath
              || (record.worktreePath !== undefined
                && pathComparisonKey(record.worktreePath) === pathComparisonKey(task.worktreePath)))
            && (!task.baseRevision || record.baseRevision === task.baseRevision)
            && (task.status !== 'succeeded' || record.status === 'passed');
          if (!evidenceScopeMatches || !record || !recordMatchesTaskLineage(record, expectedLineage, true)) {
            issues.push(issue(
              'evidence-lineage-drift',
              `Worker Task Evidence 未绑定当前 Run/Task/Attempt：${taskId}/${evidenceId}`,
              { runId: run.runId, taskId },
            ));
          }
        }
      }
      if (task.status === 'succeeded' && !hasWorkerSuccessProvenance(task)) {
        issues.push(issue(
          'acceptance-lineage-drift',
          `succeeded Worker Task 缺少有效 Evidence/Acceptance provenance：${taskId}`,
          { runId: run.runId, taskId },
        ));
      }
      if (input.acceptances && task.acceptanceId) {
        const acceptance = input.acceptances.find((record) => record.acceptanceId === task.acceptanceId);
        const acceptanceScopeMatches = !!acceptance
          && acceptance.passed === (task.status === 'succeeded')
          && (task.status !== 'succeeded' || acceptance.failedChecks.length === 0)
          && acceptance.orchestrationId === (run.orchestrationId ?? run.runId)
          && acceptance.stageId === expectedAcceptanceStageId
          && (!task.worktreePath
            || pathComparisonKey(acceptance.worktreePath) === pathComparisonKey(task.worktreePath));
        if (!acceptanceScopeMatches || !acceptance || !recordMatchesTaskLineage(acceptance, expectedLineage, true)) {
          issues.push(issue(
            'acceptance-lineage-drift',
            `Worker Task Acceptance 未绑定当前 Run/Task/Attempt：${taskId}/${task.acceptanceId}`,
            { runId: run.runId, taskId },
          ));
        }
      }
    }
  }

  if (input.sideEffects) {
    const runsById = new Map(input.runs.map((run) => [run.runId, run]));
    for (const effect of input.sideEffects) {
      if (!effect.runId || !effect.taskId || !effect.taskExecutionId || !effect.attemptId) {
        issues.push(issue(
          'side-effect-lineage-drift',
          `side-effect 缺少完整 Run/Task/Execution/Attempt lineage：${effect.idempotencyKey}`,
          { runId: effect.runId, taskId: effect.taskId },
        ));
        continue;
      }
      const effectTaskId = effect.taskId;
      const run = runsById.get(effect.runId);
      const task = run?.tasks[effectTaskId];
      if (!run || !task) {
        issues.push(issue(
          'side-effect-lineage-drift',
          `side-effect 未绑定 ProjectFile Worker Task：${effect.idempotencyKey}`,
          { runId: effect.runId, taskId: effectTaskId },
        ));
        continue;
      }
      const expectedLineage: ExpectedTaskLineage = {
        runId: run.runId,
        taskId: effectTaskId,
        taskExecutionId: task.taskExecutionId ?? createTaskExecutionId(run.runId, effectTaskId),
        currentAttempt: task.pendingAttempt ?? task.attempt,
        explicit: true,
      };
      const currentLineageMatches = recordMatchesTaskLineage(effect, expectedLineage, true);
      if (!currentLineageMatches && isVerifiedHistoricalEffect(effect, expectedLineage)) {
        continue;
      }
      if (!currentLineageMatches) {
        issues.push(issue(
          'side-effect-lineage-drift',
          `side-effect 未绑定当前 Run/Task/Attempt：${effect.idempotencyKey}`,
          { runId: run.runId, taskId: effectTaskId },
        ));
      }
      const isArtifactDelivery = effect.kind === 'artifact-delivery'
        || effect.idempotencyKey.startsWith('artifact-delivery:');
      if (isArtifactDelivery) {
        const candidateId = effect.idempotencyKey.startsWith('artifact-delivery:')
          ? effect.idempotencyKey.slice('artifact-delivery:'.length)
          : '';
        const acceptance = input.acceptances?.find((record) => record.acceptanceId === task.acceptanceId);
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
          issues.push(issue(
            'side-effect-lineage-drift',
            `artifact-delivery receipt 与当前任务不一致：${effect.idempotencyKey}`,
            { runId: run.runId, taskId: effectTaskId },
          ));
        }
        continue;
      }
      const isCleanup = effect.idempotencyKey.startsWith('cleanup:');
      const expectedTarget = isCleanup ? task.worktreePath : task.worktreeId;
      const expectedInputHash = isCleanup
        ? `${task.baseRevision ?? ''}:${effect.receipt?.outputHash ?? ''}`
        : task.taskDefinitionVersion === 1
          ? task.worktreePath && task.branch
            ? JSON.stringify([
              run.runId,
              effectTaskId,
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
      const lifecycleMatches = effect.kind === (isCleanup ? 'worktree-cleanup' : 'worker-execution')
        && expectedTarget !== undefined
        && effect.target === expectedTarget
        && inputHashMatches
        && (effect.status !== 'receipt'
          || (effect.receipt?.outcome !== undefined && effect.receipt.receiptId === `${effect.idempotencyKey}:receipt`));
      if (!lifecycleMatches) {
        issues.push(issue(
          'side-effect-lineage-drift',
          `side-effect kind/target/inputHash/status/receipt 与当前任务不一致：${effect.idempotencyKey}`,
          { runId: run.runId, taskId: effectTaskId },
        ));
      }
    }
  }

  for (const runId of Object.keys(projection.runs)) {
    if (!runsById.has(runId)) {
      issues.push(issue(
        'orphaned-run-event',
        `事件流存在 ProjectFile 未登记的 Worker Run：${runId}`,
        { runId },
      ));
    }
  }
  const taskExecutionKeys = new Set(
    input.runs.flatMap((run) => Object.keys(run.tasks).map((taskId) => `${run.runId}\u0000${taskId}`)),
  );
  for (const execution of Object.values(projection.taskExecutions)) {
    if (!taskExecutionKeys.has(`${execution.runId}\u0000${execution.taskId}`)) {
      issues.push(issue(
        'orphaned-task-event',
        `事件流存在 ProjectFile 未登记的 Worker Task Execution：${execution.taskExecutionId}`,
        { runId: execution.runId, taskId: execution.taskId },
      ));
    }
  }
  const taskIds = new Set(input.runs.flatMap((run) => Object.keys(run.tasks)));
  for (const taskId of Object.keys(projection.tasks)) {
    if (!taskIds.has(taskId)) {
      issues.push(issue(
        'orphaned-task-event',
        `事件流存在 ProjectFile 未登记的 Worker Task：${taskId}`,
        { taskId },
      ));
    }
  }

  return { ok: issues.length === 0, projection, issues };
}
