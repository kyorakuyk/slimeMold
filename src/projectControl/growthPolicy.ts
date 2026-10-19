import type { TaskGraphTriage } from './triage';
import type { ProjectTaskGraph } from './types';

export type GrowthViolationCode =
  | 'not-independently-verifiable'
  | 'overlapping-scope'
  | 'over-growth';

export interface GrowthViolation {
  code: GrowthViolationCode;
  taskIds: string[];
  message: string;
}

export function checkGrowth(
  graph: ProjectTaskGraph,
  triage: Pick<TaskGraphTriage, 'level'>,
): GrowthViolation[] {
  const violations: GrowthViolation[] = [];
  if (triage.level === 'L0' && graph.tasks.length > 1) {
    violations.push({
      code: 'over-growth',
      taskIds: graph.tasks.map((task) => task.id),
      message: `L0 任务图包含 ${graph.tasks.length} 个任务，建议合并为 1 个直通任务。`,
    });
  }
  violations.push(...graph.tasks
    .filter((task) => task.acceptanceCriteria.length === 0)
    .map((task): GrowthViolation => ({
      code: 'not-independently-verifiable',
      taskIds: [task.id],
      message: `任务“${task.id}”没有验收标准，无法独立验收。`,
    })));
  const dependencies = new Map(graph.tasks.map((task) => [task.id, task.dependsOn]));
  const dependsOnTransitively = (fromId: string, targetId: string): boolean => {
    const pending = [...(dependencies.get(fromId) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const dependencyId = pending.pop();
      if (!dependencyId || visited.has(dependencyId)) continue;
      if (dependencyId === targetId) return true;
      visited.add(dependencyId);
      pending.push(...(dependencies.get(dependencyId) ?? []));
    }
    return false;
  };

  for (let leftIndex = 0; leftIndex < graph.tasks.length; leftIndex += 1) {
    const left = graph.tasks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < graph.tasks.length; rightIndex += 1) {
      const right = graph.tasks[rightIndex];
      if (!right) continue;
      if (dependsOnTransitively(left.id, right.id) || dependsOnTransitively(right.id, left.id)) continue;

      const sharedFiles = [...new Set(left.scope)].filter((file) => right.scope.includes(file));
      if (sharedFiles.length === 0) continue;
      violations.push({
        code: 'overlapping-scope',
        taskIds: [left.id, right.id],
        message: `任务“${left.id}”和“${right.id}”共享文件 ${sharedFiles.join('、')}，且不存在直接或间接依赖。`,
      });
    }
  }

  return violations;
}
