import { describe, expect, it } from 'vitest';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import type { WorkerTaskLease } from '../domain/workerQueue';
import type { ProjectTask } from '../projectControl/types';
import { createAntigravityWorkerExecutor } from './antigravityWorkerExecutor';
import { buildCodexWorkerPrompt } from './codexWorkerExecutor';
import { renderTaskContract } from '../projectControl/workOrder';

function createTask(input: {
  id: string;
  title: string;
  description: string;
  moduleId: string;
  scope: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
}): ProjectTask {
  return {
    version: 1,
    id: input.id,
    architectureId: 'architecture-1',
    title: input.title,
    description: input.description,
    moduleId: input.moduleId,
    scope: input.scope,
    dependsOn: input.dependsOn,
    acceptanceCriteria: input.acceptanceCriteria,
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
  };
}

function createLease(
  task: ProjectTask,
  input: { worktreeId: string; path: string; branch: string; baseRevision: string },
  dependencyArtifacts?: WorkerTaskLease['dependencyArtifacts'],
): WorkerTaskLease {
  const runId = 'run-1';
  const taskExecutionId = createTaskExecutionId(runId, task.id);
  return {
    projectId: 'project-1',
    runId,
    task,
    assignment: input,
    attempt: 1,
    taskExecutionId,
    attemptId: createAttemptId(taskExecutionId, 1),
    ...(dependencyArtifacts ? { dependencyArtifacts } : {}),
  };
}

const simpleLease = createLease(
  createTask({
    id: 'task-1',
    title: '实现 Worker 队列',
    description: '在隔离 worktree 中完成队列执行器',
    moduleId: 'module-1',
    scope: ['src/domain/workerQueue.ts', 'src/dev/workerAllocator.ts'],
    dependsOn: [],
    acceptanceCriteria: ['npm run test 通过', '没有跨 worktree 写入'],
  }),
  {
    worktreeId: 'worktree-1',
    path: 'C:/worktrees/task-1',
    branch: 'worker/task-1',
    baseRevision: 'base-1',
  },
);

const dependentLease = createLease(
  createTask({
    id: 'task-2',
    title: '实现依赖模块',
    description: '基于上游成果实现下游模块',
    moduleId: 'module-2',
    scope: ['src/feature.ts', 'tests/feature.test.ts'],
    dependsOn: ['task-1'],
    acceptanceCriteria: ['测试覆盖新行为', '不修改依赖工作树'],
  }),
  {
    worktreeId: 'worktree-2',
    path: 'C:/worktrees/task-2',
    branch: 'worker/task-2',
    baseRevision: 'base-2',
  },
  [{ taskId: 'task-1', attempt: 1, path: 'C:/worktrees/task-1', branchRevision: 'abc123' }],
);

const promptCases: Array<{ name: string; lease: WorkerTaskLease }> = [
  { name: 'simple lease with empty optional fields', lease: simpleLease },
  { name: 'dependent lease with multiple acceptance criteria', lease: dependentLease },
];

async function captureAntigravityPrompt(lease: WorkerTaskLease): Promise<string> {
  let capturedPrompt = '';
  const executor = createAntigravityWorkerExecutor({
    generation: 1,
    acceptance: {
      evaluate: () => ({
        passed: true,
        evidenceIds: ['evidence-prompt-golden'],
        acceptanceId: 'acceptance-prompt-golden',
      }),
    },
    invoker: {
      execute: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          outcome: 'completed',
          text: 'completed',
          sessionDir: `${lease.assignment.path}/.agents/slimemold-worker/session-1`,
        };
      },
    },
  });

  const result = await executor.execute(lease);
  expect(result.status).toBe('succeeded');
  return capturedPrompt;
}

describe('Worker prompt characterization baselines', () => {
  describe(promptCases[0].name, () => {
    it('pins the complete Codex prompt', () => {
      expect(buildCodexWorkerPrompt(simpleLease)).toMatchInlineSnapshot(`
        "你是 SlimeMold 的实现 Worker。只在当前已分配的 worktree 内完成一个任务。

        项目级约定
        （未提供 ContextPack）

        模块级契约
        模块：module-1
        类别：implementation

        本任务
        任务标题：实现 Worker 队列
        任务描述：在隔离 worktree 中完成队列执行器
        允许涉及的范围：src/domain/workerQueue.ts, src/dev/workerAllocator.ts
        依赖任务：(无)
        验收标准：
        - npm run test 通过
        - 没有跨 worktree 写入

        运行时信息：
        Worktree: C:/worktrees/task-1
        Attempt: 1

        约束：
        - 只能修改当前 worktree；只读依赖成果路径仅用于读取/复制参考，不得在原依赖 worktree 写入。
        - 不要 push、merge、release 或删除远程资源。
        - 不要把 API key、token、密码或其它 secret 写入文件、输出或摘要。
        - 完成后只报告做了什么；是否成功由宿主运行确定性验收决定。"
      `);
    });

    it('pins the complete Antigravity prompt', async () => {
      await expect(captureAntigravityPrompt(simpleLease)).resolves.toMatchInlineSnapshot(`
        "你是 SlimeMold 的 Antigravity 实现 Worker。只在当前已分配 Worktree 内工作。

        项目级约定
        （未提供 ContextPack）

        模块级契约
        模块：module-1
        类别：implementation

        本任务
        任务标题：实现 Worker 队列
        任务描述：在隔离 worktree 中完成队列执行器
        允许涉及的范围：src/domain/workerQueue.ts, src/dev/workerAllocator.ts
        依赖任务：(无)
        验收标准：
        - npm run test 通过
        - 没有跨 worktree 写入

        运行时信息：
        Worktree: C:/worktrees/task-1
        Attempt: 1

        强制边界：
        - 先调用 slimemold_get_task_context，再开始修改。
        - 只能修改当前 Worktree；不得修改依赖 Worktree、主仓库、远程资源或凭据。
        - 用 slimemold_report_progress 汇报进度。
        - 完成后调用 slimemold_submit_attempt_result；这只表示请求 Host Acceptance，不代表成功。
        - 遇到歧义调用 slimemold_request_feedback，不要猜测。"
      `);
    });
  });

  describe(promptCases[1].name, () => {
    it('pins the complete Codex prompt', () => {
      expect(buildCodexWorkerPrompt(dependentLease)).toMatchInlineSnapshot(`
        "你是 SlimeMold 的实现 Worker。只在当前已分配的 worktree 内完成一个任务。

        项目级约定
        （未提供 ContextPack）

        模块级契约
        模块：module-2
        类别：implementation

        本任务
        任务标题：实现依赖模块
        任务描述：基于上游成果实现下游模块
        允许涉及的范围：src/feature.ts, tests/feature.test.ts
        依赖任务：task-1
        验收标准：
        - 测试覆盖新行为
        - 不修改依赖工作树

        运行时信息：
        Worktree: C:/worktrees/task-2
        Attempt: 1
        已成功完成的依赖成果（只读参考；只能把需要的内容复制/整合到当前 Worktree，禁止修改这些路径）：
        - task-1 attempt=1 path=C:/worktrees/task-1 revision=abc123

        约束：
        - 只能修改当前 worktree；只读依赖成果路径仅用于读取/复制参考，不得在原依赖 worktree 写入。
        - 不要 push、merge、release 或删除远程资源。
        - 不要把 API key、token、密码或其它 secret 写入文件、输出或摘要。
        - 完成后只报告做了什么；是否成功由宿主运行确定性验收决定。"
      `);
    });

    it('pins the complete Antigravity prompt', async () => {
      await expect(captureAntigravityPrompt(dependentLease)).resolves.toMatchInlineSnapshot(`
        "你是 SlimeMold 的 Antigravity 实现 Worker。只在当前已分配 Worktree 内工作。

        项目级约定
        （未提供 ContextPack）

        模块级契约
        模块：module-2
        类别：implementation

        本任务
        任务标题：实现依赖模块
        任务描述：基于上游成果实现下游模块
        允许涉及的范围：src/feature.ts, tests/feature.test.ts
        依赖任务：task-1
        验收标准：
        - 测试覆盖新行为
        - 不修改依赖工作树

        运行时信息：
        Worktree: C:/worktrees/task-2
        Attempt: 1

        强制边界：
        - 先调用 slimemold_get_task_context，再开始修改。
        - 只能修改当前 Worktree；不得修改依赖 Worktree、主仓库、远程资源或凭据。
        - 用 slimemold_report_progress 汇报进度。
        - 完成后调用 slimemold_submit_attempt_result；这只表示请求 Host Acceptance，不代表成功。
        - 遇到歧义调用 slimemold_request_feedback，不要猜测。"
      `);
    });
  });

  it.each(promptCases)('$name leaves optional task and lease context absent', ({ lease }) => {
    expect(lease.task.issueId).toBeUndefined();
    expect(lease.task.workflowId).toBeUndefined();
    expect(lease.task.stageId).toBeUndefined();
    expect(lease.orchestrationId).toBeUndefined();
    expect(lease.contextPack).toBeUndefined();
  });

  it.each(promptCases)('$name includes the exact shared task contract in both prompts', async ({ lease }) => {
    const contract = renderTaskContract(lease);

    expect(buildCodexWorkerPrompt(lease)).toContain(contract);
    expect(await captureAntigravityPrompt(lease)).toContain(contract);
  });

  it.each(promptCases)('$name keeps every existing task detail in the shared contract', ({ lease }) => {
    const contract = renderTaskContract(lease);
    const taskFacts = [
      lease.task.title,
      lease.task.description,
      ...lease.task.scope,
      ...lease.task.dependsOn,
      ...lease.task.acceptanceCriteria,
    ];

    for (const fact of taskFacts) expect(contract).toContain(fact);
  });

  it('keeps Codex dependency artifact paths in runtime context after the stable contract', () => {
    const contract = renderTaskContract(dependentLease);
    const prompt = buildCodexWorkerPrompt(dependentLease);
    const runtimeContext = prompt.slice(prompt.indexOf(contract) + contract.length);

    expect(contract).not.toContain('C:/worktrees/task-1');
    expect(runtimeContext).toContain('Worktree: C:/worktrees/task-2');
    expect(runtimeContext).toContain('Attempt: 1');
    expect(runtimeContext).toContain('已成功完成的依赖成果');
    expect(runtimeContext).toContain('task-1 attempt=1 path=C:/worktrees/task-1 revision=abc123');
  });
});
