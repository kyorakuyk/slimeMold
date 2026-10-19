import { pathComparisonKey } from '../dev/path-utils';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { resolveWorkerAcceptanceStageId, restoreWorkerRunQueue } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { hasWorkerSuccessProvenance, workerRunSuccessIsValid } from '../domain/workerSuccess';
import type { ProjectTaskGraph } from './types';
import type {
  ExpectedTaskLineage,
  WorkerRunConsistencyAuditContext,
} from './workerRunConsistencyTypes';
import { issue, recordMatchesTaskLineage, sameStringSet } from './workerRunConsistencyUtils';

type ReplayedWorkerTask = NonNullable<
  WorkerRunConsistencyAuditContext['projection']['taskExecutions'][string]
  | WorkerRunConsistencyAuditContext['projection']['tasks'][string]
>;

interface WorkerTaskAuditContext {
  audit: WorkerRunConsistencyAuditContext;
  run: WorkerRunQueueState;
  taskId: string;
  task: WorkerRunQueueState['tasks'][string];
  expectedAcceptanceStageId?: string;
  expectedLineage: ExpectedTaskLineage;
  replayedExecution: WorkerRunConsistencyAuditContext['projection']['taskExecutions'][string] | undefined;
  replayedTask: ReplayedWorkerTask;
}

/** 单个 Worker Task 校验共用的事实（参数对象，避免长位置参数列表）。 */
interface WorkerTaskCheckContext {
  context: WorkerRunConsistencyAuditContext;
  run: WorkerRunQueueState;
  taskGraph: ProjectTaskGraph | undefined;
  graphVersionMatches: boolean;
}

export function checkWorkerRun(context: WorkerRunConsistencyAuditContext, run: WorkerRunQueueState): void {
  const taskGraph = context.input.taskGraphs?.find((graph) => graph.id === run.taskGraphId);
  const graphVersionMatches = checkTaskGraphFacts(context, run, taskGraph);
  checkSucceededRunFacts(context, run, taskGraph);
  checkReplayedRunFacts(context, run);
  const taskCheckContext: WorkerTaskCheckContext = { context, run, taskGraph, graphVersionMatches };
  for (const [taskId, task] of Object.entries(run.tasks)) {
    checkWorkerTask(taskCheckContext, taskId, task);
  }
}

function checkTaskGraphFacts(
  context: WorkerRunConsistencyAuditContext,
  run: WorkerRunQueueState,
  taskGraph: ProjectTaskGraph | undefined,
): boolean {
  if (context.duplicateGraphIds.has(run.taskGraphId)) {
    context.issues.push(issue(
      'task-graph-duplicate',
      `Worker Run 关联的 TaskGraph id 重复，拒绝审计：${run.taskGraphId}`,
      { runId: run.runId },
    ));
  }
  if (context.input.taskGraphs !== undefined && !taskGraph) {
    context.issues.push(issue(
      'acceptance-lineage-drift',
      `Worker Run 缺少可信 TaskGraph：${run.taskGraphId}`,
      { runId: run.runId },
    ));
  }
  const graphVersionMatches = taskGraph?.graphVersion === run.taskGraphVersion;
  if (taskGraph && !graphVersionMatches) {
    context.issues.push(issue(
      'task-graph-version-drift',
      `Worker Run 的 TaskGraph version 不匹配：${run.taskGraphId}`,
      { runId: run.runId },
    ));
  }
  if (taskGraph && taskGraph.approval !== 'approved') {
    context.issues.push(issue(
      'task-graph-unapproved',
      `Worker Run 关联的 TaskGraph 未获批准：${run.taskGraphId}`,
      { runId: run.runId },
    ));
  }
  if (context.input.taskGraphs !== undefined) {
    if (!taskGraph) {
      context.issues.push(issue(
        'acceptance-lineage-drift',
        `Worker Run 缺少用于 restore validation 的 TaskGraph：${run.taskGraphId}`,
        { runId: run.runId },
      ));
    } else {
      try {
        restoreWorkerRunQueue({ taskGraph, state: run });
      } catch (cause) {
        context.issues.push(issue(
          'control-state-drift',
          `Worker Run restore validation 失败：${cause instanceof Error ? cause.message : String(cause)}`,
          { runId: run.runId },
        ));
      }
    }
  }
  return graphVersionMatches;
}

function checkSucceededRunFacts(
  context: WorkerRunConsistencyAuditContext,
  run: WorkerRunQueueState,
  taskGraph: ProjectTaskGraph | undefined,
): void {
  if (run.status === 'succeeded') {
    if (!workerRunSuccessIsValid(Object.values(run.tasks))) {
      context.issues.push(issue(
        'acceptance-lineage-drift',
        `succeeded Worker Run 缺少非空且完整的 success provenance：${run.runId}`,
        { runId: run.runId },
      ));
    }
    if (taskGraph) {
      const graphTaskIds = taskGraph.tasks.map((task) => task.id);
      const runTaskIds = Object.keys(run.tasks);
      const complete = runTaskIds.length === graphTaskIds.length
        && graphTaskIds.every((taskId) => Object.prototype.hasOwnProperty.call(run.tasks, taskId));
      if (!complete) {
        context.issues.push(issue(
          'task-status-drift',
          `succeeded Worker Run 未覆盖批准 TaskGraph 的全部任务：${run.runId}`,
          { runId: run.runId },
        ));
      }
    }
  }
}

function checkReplayedRunFacts(context: WorkerRunConsistencyAuditContext, run: WorkerRunQueueState): void {
  const replayedRun = context.projection.runs[run.runId];
  if (!replayedRun) {
    context.issues.push(issue(
      'missing-run-event',
      `ProjectFile 中存在 Worker Run，但事件流没有对应事实：${run.runId}`,
      { runId: run.runId },
    ));
  } else if (replayedRun.status !== run.status) {
    context.issues.push(issue(
      'run-status-drift',
      `Worker Run 状态与事件重放不一致：${run.runId}（ProjectFile=${run.status}，events=${replayedRun.status}）`,
      { runId: run.runId },
    ));
  }
}

function checkWorkerTask(
  taskCheckContext: WorkerTaskCheckContext,
  taskId: string,
  task: WorkerRunQueueState['tasks'][string],
): void {
  const { context, run } = taskCheckContext;
  const expectedAcceptanceStageId = checkAcceptanceStage(taskCheckContext, taskId, task);
  const expectedTaskExecutionId = createTaskExecutionId(run.runId, taskId);
  if (task.taskExecutionId && task.taskExecutionId !== expectedTaskExecutionId) {
    context.issues.push(issue(
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
  const replayedExecution = context.projection.taskExecutions[taskExecutionId];
  const replayedTask = replayedExecution ?? context.projection.tasks[taskId];
  if (!replayedTask || (replayedTask.runId && replayedTask.runId !== run.runId)) {
    context.issues.push(issue(
      'missing-task-event',
      `ProjectFile 中存在 Worker Task，但事件流没有对应事实：${taskId}`,
      { runId: run.runId, taskId },
    ));
    return;
  }
  const auditTask: WorkerTaskAuditContext = {
    audit: context,
    run,
    taskId,
    task,
    expectedAcceptanceStageId,
    expectedLineage,
    replayedExecution,
    replayedTask,
  };
  checkReplayedTaskFacts(auditTask);
  checkTaskAttemptFacts(auditTask);
  checkTaskEvidenceFacts(auditTask);
  checkTaskSuccessProvenance(auditTask);
  checkTaskAcceptanceFacts(auditTask);
}

function checkAcceptanceStage(
  taskCheckContext: WorkerTaskCheckContext,
  taskId: string,
  task: WorkerRunQueueState['tasks'][string],
): string | undefined {
  const { context, run, taskGraph, graphVersionMatches } = taskCheckContext;
  const trustedGraph = taskGraph && graphVersionMatches && taskGraph.approval === 'approved'
    ? taskGraph
    : undefined;
  const taskDefinition = trustedGraph?.tasks.find((item) => item.id === taskId);
  const expectedAcceptanceStageId = context.input.taskGraphs === undefined
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
    context.issues.push(issue(
      'acceptance-lineage-drift',
      `Worker Task acceptance stage 无效：${taskId}`,
      { runId: run.runId, taskId },
    ));
  } else if (persistedAcceptanceStageId !== undefined
    && persistedAcceptanceStageId !== expectedAcceptanceStageId) {
    context.issues.push(issue(
      'acceptance-lineage-drift',
      `Worker Task acceptance stage 与可信 TaskGraph 不一致：${taskId}`,
      { runId: run.runId, taskId },
    ));
  }
  return expectedAcceptanceStageId;
}

function checkReplayedTaskFacts(taskContext: WorkerTaskAuditContext): void {
  const { audit, run, taskId, task, replayedExecution, replayedTask } = taskContext;
  if (replayedExecution && (
    replayedExecution.taskExecutionId !== taskContext.expectedLineage.taskExecutionId
    || replayedExecution.taskId !== taskId
    || replayedExecution.runId !== run.runId
  )) {
    audit.issues.push(issue(
      'task-execution-lineage-drift',
      `Worker Task execution lineage 与事件重放不一致：${taskId}`,
      { runId: run.runId, taskId },
    ));
  }
  if (replayedTask.status !== task.status) {
    audit.issues.push(issue(
      'task-status-drift',
      `Worker Task 状态与事件重放不一致：${taskId}（ProjectFile=${task.status}，events=${replayedTask.status}）`,
      { runId: run.runId, taskId },
    ));
  }
  if (replayedTask.runId && replayedTask.runId !== run.runId) {
    audit.issues.push(issue(
      'task-run-drift',
      `Worker Task 所属 Run 与事件重放不一致：${taskId}`,
      { runId: run.runId, taskId },
    ));
  }
  if (task.evidenceIds.length > 0 || replayedTask.evidenceIds !== undefined) {
    if (!sameStringSet(task.evidenceIds, replayedTask.evidenceIds)) {
      audit.issues.push(issue(
        'task-evidence-drift',
        `Worker Task Evidence 与事件重放不一致：${taskId}`,
        { runId: run.runId, taskId },
      ));
    }
  }
  if (task.acceptanceId !== replayedTask.acceptanceId) {
    audit.issues.push(issue(
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
    audit.issues.push(issue(
      'task-cleanup-drift',
      `Worker Task cleanup 状态或 receipt 与事件重放不一致：${taskId}`,
      { runId: run.runId, taskId },
    ));
  }
}

function checkTaskAttemptFacts(taskContext: WorkerTaskAuditContext): void {
  const { audit, run, taskId, task, replayedExecution } = taskContext;
  if (task.attempt > 0) {
    const expectedAttemptId = task.currentAttemptId ?? createAttemptId(taskContext.expectedLineage.taskExecutionId, task.attempt);
    const replayedAttempt = audit.projection.attempts[expectedAttemptId];
    if (!replayedAttempt) {
      audit.issues.push(issue(
        'missing-attempt-event',
        `ProjectFile 中存在 Worker Attempt，但事件流没有对应事实：${taskId}/a${task.attempt}`,
        { runId: run.runId, taskId },
      ));
    } else if (
      replayedAttempt.taskExecutionId !== taskContext.expectedLineage.taskExecutionId
      || replayedAttempt.taskId !== taskId
      || replayedAttempt.runId !== run.runId
      || replayedAttempt.attempt !== task.attempt
    ) {
      audit.issues.push(issue(
        'attempt-lineage-drift',
        `Worker Attempt lineage 与事件重放不一致：${taskId}/a${task.attempt}`,
        { runId: run.runId, taskId },
      ));
    }
    if (task.currentAttemptId && replayedExecution?.currentAttemptId !== task.currentAttemptId) {
      audit.issues.push(issue(
        'attempt-lineage-drift',
        `Worker Task 当前 Attempt 与事件重放不一致：${taskId}`,
        { runId: run.runId, taskId },
      ));
    }
  }
}

function checkTaskEvidenceFacts(taskContext: WorkerTaskAuditContext): void {
  const { audit, run, taskId, task, expectedAcceptanceStageId, expectedLineage } = taskContext;
  if (audit.input.evidence) {
    for (const evidenceId of task.evidenceIds) {
      const record = audit.evidenceById.get(evidenceId);
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
        audit.issues.push(issue(
          'evidence-lineage-drift',
          `Worker Task Evidence 未绑定当前 Run/Task/Attempt：${taskId}/${evidenceId}`,
          { runId: run.runId, taskId },
        ));
      }
    }
  }
}

function checkTaskSuccessProvenance(taskContext: WorkerTaskAuditContext): void {
  const { audit, run, taskId, task } = taskContext;
  if (task.status === 'succeeded' && !hasWorkerSuccessProvenance(task)) {
    audit.issues.push(issue(
      'acceptance-lineage-drift',
      `succeeded Worker Task 缺少有效 Evidence/Acceptance provenance：${taskId}`,
      { runId: run.runId, taskId },
    ));
  }
}

function checkTaskAcceptanceFacts(taskContext: WorkerTaskAuditContext): void {
  const { audit, run, taskId, task, expectedAcceptanceStageId, expectedLineage } = taskContext;
  if (audit.input.acceptances && task.acceptanceId) {
    const acceptance = audit.input.acceptances.find((record) => record.acceptanceId === task.acceptanceId);
    const acceptanceScopeMatches = !!acceptance
      && acceptance.passed === (task.status === 'succeeded')
      && (task.status !== 'succeeded' || acceptance.failedChecks.length === 0)
      && acceptance.orchestrationId === (run.orchestrationId ?? run.runId)
      && acceptance.stageId === expectedAcceptanceStageId
      && (!task.worktreePath
        || pathComparisonKey(acceptance.worktreePath) === pathComparisonKey(task.worktreePath));
    if (!acceptanceScopeMatches || !acceptance || !recordMatchesTaskLineage(acceptance, expectedLineage, true)) {
      audit.issues.push(issue(
        'acceptance-lineage-drift',
        `Worker Task Acceptance 未绑定当前 Run/Task/Attempt：${taskId}/${task.acceptanceId}`,
        { runId: run.runId, taskId },
      ));
    }
  }
}
