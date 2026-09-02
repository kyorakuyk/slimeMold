import {
  replayDomainEvents,
  type DomainEvent,
  type DomainProjection,
} from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';

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
  | 'orphaned-run-event'
  | 'orphaned-task-event';

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
  return { lastSequence: 0, runs: {}, tasks: {} };
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
}): WorkerRunConsistencyReport {
  const issues: WorkerRunConsistencyIssue[] = [];
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
  for (const run of input.runs) {
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
      const replayedTask = projection.tasks[taskId];
      if (!replayedTask) {
        issues.push(issue(
          'missing-task-event',
          `ProjectFile 中存在 Worker Task，但事件流没有对应事实：${taskId}`,
          { runId: run.runId, taskId },
        ));
        continue;
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
