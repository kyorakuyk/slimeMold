import type { Orchestration } from '../types/orchestration';
import type { TaskGraphProjection, TaskGraphProjectionNode } from '../projectControl/taskGraphProjection';
import {
  buildTaskGraphProjection,
  buildTaskGraphProjectionFromWorkerRun,
} from '../projectControl/taskGraphProjection';
import type { TaskGraphSelection } from '../types/taskGraphSelection';

export interface OrchestratorTaskGraphDeps {
  selected: Orchestration | null;
  /** 运行队列状态（与 buildTaskGraphProjectionFromWorkerRun 的入参同型） */
  workerRuns: readonly Parameters<typeof buildTaskGraphProjectionFromWorkerRun>[0]['run'][];
  projectId: string | null;
  taskGraphSelection: TaskGraphSelection | null;
  projectControl: {
    issues: Parameters<typeof buildTaskGraphProjection>[0]['issues'];
    taskGraphs?: Parameters<typeof buildTaskGraphProjection>[0]['graph'][];
  };
}

export interface OrchestratorTaskGraphResult {
  projection: TaskGraphProjection | null;
  error: string | null;
}

/**
 * 编排面板 DAG 投影：取选中编排最近的 worker run（或草案阶段的 sourceTaskGraphId）对应的任务图，
 * 用 worker run 还原进度；找不到图或投影失败时返回 null/错误信息。
 * 从 OrchestratorPanel 的 useMemo 回调原样抽出（同一判定顺序与同一批纯函数）。
 */
export function computeOrchestratorTaskGraph({
  selected,
  workerRuns,
  projectId,
  taskGraphSelection,
  projectControl,
}: OrchestratorTaskGraphDeps): OrchestratorTaskGraphResult {
  if (!selected) return { projection: null, error: null };
  const taskGraphRuns = workerRuns
    .filter((run) => run.projectId === projectId && run.orchestrationId === selected.id)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const latestRun = taskGraphRuns.at(-1);
  const selectedGraphId = taskGraphSelection?.projectId === projectId ? taskGraphSelection.taskGraphId : undefined;
  const graphId = selectedGraphId
    ?? latestRun?.taskGraphId
    ?? selected.draft?.stages.find((stage) => stage.sourceTaskGraphId)?.sourceTaskGraphId;
  const graph = graphId
    ? projectControl.taskGraphs?.find((item) => item.id === graphId)
    : undefined;
  if (!graph) return { projection: null, error: null };
  const issues = projectControl.issues.filter((issue) => issue.projectId === projectId || issue.projectId === null);
  try {
    if (latestRun) {
      return {
        projection: buildTaskGraphProjectionFromWorkerRun({ graph, issues, run: latestRun }),
        error: null,
      };
    }
    return {
      projection: buildTaskGraphProjection({
        graph,
        issues,
        execution: { lastSequence: 0, runs: {}, tasks: {}, taskExecutions: {}, attempts: {} },
      }),
      error: null,
    };
  } catch (cause) {
    return {
      projection: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export type { TaskGraphProjectionNode };
