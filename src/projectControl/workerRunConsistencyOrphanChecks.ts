import type { WorkerRunConsistencyAuditContext } from './workerRunConsistencyTypes';
import { issue } from './workerRunConsistencyUtils';

export function checkOrphanedWorkerEvents(context: WorkerRunConsistencyAuditContext): void {
  for (const runId of Object.keys(context.projection.runs)) {
    if (!context.runsById.has(runId)) {
      context.issues.push(issue(
        'orphaned-run-event',
        `事件流存在 ProjectFile 未登记的 Worker Run：${runId}`,
        { runId },
      ));
    }
  }
  const taskExecutionKeys = new Set(
    context.input.runs.flatMap((run) => Object.keys(run.tasks).map((taskId) => `${run.runId}\u0000${taskId}`)),
  );
  for (const execution of Object.values(context.projection.taskExecutions)) {
    if (!taskExecutionKeys.has(`${execution.runId}\u0000${execution.taskId}`)) {
      context.issues.push(issue(
        'orphaned-task-event',
        `事件流存在 ProjectFile 未登记的 Worker Task Execution：${execution.taskExecutionId}`,
        { runId: execution.runId, taskId: execution.taskId },
      ));
    }
  }
  const taskIds = new Set(context.input.runs.flatMap((run) => Object.keys(run.tasks)));
  for (const taskId of Object.keys(context.projection.tasks)) {
    if (!taskIds.has(taskId)) {
      context.issues.push(issue(
        'orphaned-task-event',
        `事件流存在 ProjectFile 未登记的 Worker Task：${taskId}`,
        { taskId },
      ));
    }
  }
}
