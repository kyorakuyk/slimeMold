import type { WorkerTaskLease } from '../domain/workerQueue';

type ContextReference = NonNullable<WorkerTaskLease['contextPack']>['decisionRefs'][number];

function referenceLabel(reference: ContextReference): string {
  return `${reference.kind}:${reference.id}@${reference.version}`;
}

function listSection(label: string, items: readonly string[]): string[] {
  return [
    `${label}：`,
    ...(items.length > 0 ? items.map((item) => `- ${item}`) : ['- (无)']),
  ];
}

function referenceSection(label: string, items: readonly ContextReference[]): string[] {
  return listSection(label, items.map(referenceLabel));
}

function joinedOrFallback(items: readonly string[] | undefined, fallback: string): string {
  return items && items.length > 0 ? items.join(', ') : fallback;
}

/**
 * Render the stable project/module contract before task-specific Worker instructions.
 * Run identity, current worktree, and dependency-artifact locations stay in runtime context.
 */
export function renderTaskContract(lease: WorkerTaskLease): string {
  const { task, contextPack } = lease;
  const projectSection = contextPack
    ? [
      `项目目标：${contextPack.goal}`,
      ...listSection('非目标', contextPack.nonGoals),
      ...referenceSection('决策引用', contextPack.decisionRefs),
      ...referenceSection('证据引用', contextPack.evidenceRefs),
    ]
    : ['（未提供 ContextPack）'];

  const moduleSection = [
    `模块：${task.moduleId}`,
    `类别：${task.category}`,
    ...(contextPack
      ? [
        `允许文件：${joinedOrFallback(contextPack.scope.allowedFiles, '(未声明)')}`,
        ...listSection('必需文件', contextPack.requiredFiles),
        ...referenceSection('必需文档', contextPack.requiredDocuments),
        ...referenceSection('依赖引用', contextPack.dependencyRefs),
        ...listSection('补充验收标准', contextPack.acceptanceCriteria),
        `允许工具：${joinedOrFallback(contextPack.scope.allowedTools, '(未声明)')}`,
        `允许数据类别：${joinedOrFallback(contextPack.scope.allowedDataClasses, '(未声明)')}`,
        `允许角色：${joinedOrFallback(contextPack.scope.allowedAgentRoles, '(未声明)')}`,
      ]
      : []),
  ];

  const taskSection = [
    `任务标题：${task.title}`,
    `任务描述：${task.description}`,
    `允许涉及的范围：${joinedOrFallback(task.scope, '(未声明)')}`,
    `依赖任务：${joinedOrFallback(task.dependsOn, '(无)')}`,
    '验收标准：',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ];

  return [
    '项目级约定',
    ...projectSection,
    '',
    '模块级契约',
    ...moduleSection,
    '',
    '本任务',
    ...taskSection,
  ].join('\n');
}
