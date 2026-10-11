import type { ProjectTaskGraph } from './types';

export const TRIAGE_RULES_VERSION = 2;
export const L0_MAX_FILES = 2;
export const L2_MIN_MODULES = 3;
export const L2_MIN_TASKS = 6;

export type TaskTriageLevel = 'L0' | 'L1' | 'L2';

export interface TaskGraphTriage {
  level: TaskTriageLevel;
  reasons: string[];
  rulesVersion: number;
}

export function triageTaskGraph(graph: ProjectTaskGraph): TaskGraphTriage {
  if (graph.tasks.length === 0) {
    return {
      level: 'L1',
      reasons: ['任务图没有任务'],
      rulesVersion: TRIAGE_RULES_VERSION,
    };
  }

  const moduleIds = new Set(graph.tasks.map((task) => task.moduleId));
  const files = new Set(graph.tasks.flatMap((task) => task.scope));
  const unscopedTaskCount = graph.tasks.filter((task) => task.scope.length === 0).length;
  const scopeReasons = unscopedTaskCount > 0
    ? [`有 ${unscopedTaskCount} 个任务未声明 scope，不能判为 L0`]
    : [];
  const taskById = new Map(graph.tasks.map((task) => [task.id, task]));
  const hasCrossModuleDependency = graph.tasks.some((task) =>
    task.dependsOn.some((dependencyId) => {
      const dependency = taskById.get(dependencyId);
      return dependency !== undefined && dependency.moduleId !== task.moduleId;
    }),
  );

  if (unscopedTaskCount === 0 && moduleIds.size === 1 && files.size <= L0_MAX_FILES) {
    const moduleId = moduleIds.values().next().value as string;
    return {
      level: 'L0',
      reasons: [`L0：单模块 ${moduleId}，涉及 ${files.size} 个文件（上限 ${L0_MAX_FILES}）。`],
      rulesVersion: TRIAGE_RULES_VERSION,
    };
  }

  const l2Reasons: string[] = [];
  if (moduleIds.size >= L2_MIN_MODULES) {
    l2Reasons.push(`L2：涉及 ${moduleIds.size} 个模块（门槛 ${L2_MIN_MODULES}）。`);
  }
  if (hasCrossModuleDependency && graph.tasks.length >= L2_MIN_TASKS) {
    l2Reasons.push(`L2：存在跨模块依赖，包含 ${graph.tasks.length} 个任务（门槛 ${L2_MIN_TASKS}）。`);
  }
  if (l2Reasons.length > 0) {
    return {
      level: 'L2',
      reasons: [...scopeReasons, ...l2Reasons],
      rulesVersion: TRIAGE_RULES_VERSION,
    };
  }

  return {
    level: 'L1',
    reasons: [
      ...scopeReasons,
      `L1：涉及 ${moduleIds.size} 个模块和 ${files.size} 个文件，未达到 L0/L2 门槛。`,
    ],
    rulesVersion: TRIAGE_RULES_VERSION,
  };
}
