import { describe, expect, it } from 'vitest';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { WorkerTaskLease } from '../domain/workerQueue';
import { createContextPack } from './protocol';
import type { ProjectTask } from './types';
import { renderTaskContract } from './workOrder';

const runId = 'run-contract';
const task: ProjectTask = {
  version: 1,
  id: 'task-contract',
  architectureId: 'architecture-contract',
  title: '实现下游模块',
  description: '使用已批准的上游成果实现模块功能',
  moduleId: 'module-contract',
  scope: ['src/feature.ts', 'tests/feature.test.ts'],
  dependsOn: ['task-upstream'],
  acceptanceCriteria: ['新行为有测试覆盖', '不能修改上游工作树'],
  category: 'implementation',
  status: 'approved',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
};
const taskExecutionId = createTaskExecutionId(runId, task.id);
const attemptId = createAttemptId(taskExecutionId, 2);
const contextPack = createContextPack({
  schemaVersion: 1,
  contextPackId: 'context-pack-contract',
  projectId: 'project-contract',
  taskId: task.id,
  taskExecutionId,
  attemptId,
  contextVersion: 3,
  goal: '让任务施工单可复现、可审查',
  nonGoals: ['不改写旧事件', '不执行真实 GUI Worker'],
  decisionRefs: [{ projectId: 'project-contract', kind: 'decision', id: 'decision-contract', version: 2 }],
  evidenceRefs: [{ projectId: 'project-contract', kind: 'evidence', id: 'evidence-contract', version: 4 }],
  requiredFiles: ['src/projectControl/workOrder.ts'],
  requiredDocuments: [{ projectId: 'project-contract', kind: 'artifact', id: 'module-guide', version: 5 }],
  dependencyRefs: [{ projectId: 'project-contract', kind: 'task', id: 'task-upstream', version: 1 }],
  acceptanceCriteria: ['宿主验收必须通过'],
  scope: {
    allowedFiles: ['src/projectControl/workOrder.ts', 'src/feature.ts', 'tests/feature.test.ts'],
    allowedDataClasses: ['task', 'evidence'],
    allowedTools: ['read-file', 'read-evidence', 'run-tests'],
    allowedAgentRoles: ['worker'],
    maxDelegationDepth: 1,
    maxFanOut: 1,
    maxTokens: 4_000,
    maxCalls: 8,
    maxMoneyCents: 50,
    maxDurationMs: 120_000,
    expiresAt: '2026-10-12T00:00:00.000Z',
  },
  sourceVersion: 7,
});
const lease: WorkerTaskLease = {
  projectId: 'project-contract',
  runId,
  task,
  assignment: {
    worktreeId: 'worktree-contract',
    path: 'C:/private/worktrees/task-contract',
    branch: 'worker/task-contract',
    baseRevision: 'base-contract',
  },
  attempt: 2,
  taskExecutionId,
  attemptId,
  contextPack,
  dependencyArtifacts: [{
    taskId: 'task-upstream',
    attempt: 1,
    path: 'C:/private/worktrees/task-upstream',
    branchRevision: 'abc123',
  }],
};

const leaseWithoutContextPack: WorkerTaskLease = {
  ...lease,
  contextPack: undefined,
  dependencyArtifacts: undefined,
};

describe('renderTaskContract', () => {
  it('renders project context, module contract, and task details in stable-to-volatile order', () => {
    expect(renderTaskContract(lease)).toBe([
      '项目级约定',
      '项目目标：让任务施工单可复现、可审查',
      '非目标：',
      '- 不改写旧事件',
      '- 不执行真实 GUI Worker',
      '决策引用：',
      '- decision:decision-contract@2',
      '证据引用：',
      '- evidence:evidence-contract@4',
      '',
      '模块级契约',
      '模块：module-contract',
      '类别：implementation',
      '允许文件：src/projectControl/workOrder.ts, src/feature.ts, tests/feature.test.ts',
      '必需文件：',
      '- src/projectControl/workOrder.ts',
      '必需文档：',
      '- artifact:module-guide@5',
      '依赖引用：',
      '- task:task-upstream@1',
      '补充验收标准：',
      '- 宿主验收必须通过',
      '允许工具：read-file, read-evidence, run-tests',
      '允许数据类别：task, evidence',
      '允许角色：worker',
      '',
      '本任务',
      '任务标题：实现下游模块',
      '任务描述：使用已批准的上游成果实现模块功能',
      '允许涉及的范围：src/feature.ts, tests/feature.test.ts',
      '依赖任务：task-upstream',
      '验收标准：',
      '- 新行为有测试覆盖',
      '- 不能修改上游工作树',
    ].join('\n'));
  });

  it('keeps execution identity and current worktree details out of the shared contract', () => {
    const contract = renderTaskContract(lease);

    expect(contract).toBe(renderTaskContract(lease));
    expect(contract).not.toContain('C:/private/worktrees/task-contract');
    expect(contract).not.toContain('C:/private/worktrees/task-upstream');
    expect(contract).not.toContain('project-contract');
    expect(contract).not.toContain(runId);
    expect(contract).not.toContain(attemptId);
    expect(contract).not.toContain('context-pack-contract');
    expect(contract).not.toContain('contextVersion=3');
    expect(contract).not.toContain('sourceVersion=7');
    expect(contract).not.toContain('attempt=1');
    expect(contract).not.toContain('abc123');
    expect(contract).not.toContain('base-contract');
    expect(contract).not.toContain('2026-10-12T00:00:00.000Z');
  });

  it('marks the project context as absent while retaining the module and task contract', () => {
    const contract = renderTaskContract(leaseWithoutContextPack);

    expect(contract).toContain('项目级约定\n（未提供 ContextPack）');
    expect(contract).toContain('模块：module-contract');
    expect(contract).toContain('任务标题：实现下游模块');
    expect(contract).toContain('验收标准：\n- 新行为有测试覆盖\n- 不能修改上游工作树');
    expect(contract).not.toContain('C:/private/worktrees/task-contract');
  });
});
