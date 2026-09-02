import type { DomainEvent } from '../domain/contracts';
import type { RunWorkerQueueOptions, WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTask } from './types';
import { runActiveWorkerRun } from './workerRunRuntime';
import { createWorktreeAllocator } from '../dev/workerAllocator';
import { createCodexWorkerExecutor, createCodexWorkerInvoker } from '../dev/codexWorkerExecutor';
import { createDevWorkerAcceptance } from '../dev/workerAcceptance';
import type { DevSession } from '../dev/session';

export interface WorkerRunTransition {
  projectId: string;
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

export interface ProjectWorkerRunCoordinatorOptions
  extends Omit<RunWorkerQueueOptions, 'onTransition'> {
  projectId: string;
  runs: readonly WorkerRunQueueState[];
  /** 同一调用内持久化最新 registry state 与 domain events。 */
  persistTransition: (transition: WorkerRunTransition) => Promise<void> | void;
  /** 执行前核对 ProjectFile 与 durable event facts；失败时不得触碰 worktree。 */
  assertConsistency?: () => Promise<void> | void;
}

export interface ProjectWorkerRunCoordinator {
  run(runId: string): Promise<WorkerRunQueueState>;
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'item';
}

/** Host-owned worktree path factory; every worker path is a sibling of the project root. */
export function workerWorktreePathFor(
  projectPath: string,
  input: { projectId: string; runId: string; task: ProjectTask; attempt: number },
): string {
  const root = projectPath.trim().replace(/[/\\]+$/, '');
  if (!root) throw new Error('项目路径不能为空');
  return `${root}-workers/${safeSegment(input.runId)}-${safeSegment(input.task.id)}-a${Math.max(1, Math.floor(input.attempt))}`;
}

export interface GuiProjectWorkerRunCoordinatorOptions
  extends Omit<ProjectWorkerRunCoordinatorOptions, 'allocator' | 'executor'> {
  projectPath: string;
  session: DevSession;
  model?: string;
}

/** Compose the real Tauri Worker path: worktree allocator → Codex → host acceptance. */
export function createGuiProjectWorkerRunCoordinator(
  options: GuiProjectWorkerRunCoordinatorOptions,
): ProjectWorkerRunCoordinator {
  return createProjectWorkerRunCoordinator({
    projectId: options.projectId,
    runs: options.runs,
    concurrency: options.concurrency,
    sideEffects: options.sideEffects,
    assertConsistency: options.assertConsistency,
    persistTransition: options.persistTransition,
    allocator: createWorktreeAllocator(
      options.session.manager,
      (input) => workerWorktreePathFor(options.projectPath, input),
    ),
    executor: createCodexWorkerExecutor({
      invoker: createCodexWorkerInvoker(),
      acceptance: createDevWorkerAcceptance(options.session),
      model: options.model,
    }),
  });
}

/**
 * 将一个项目的 active runtime queue 接到宿主持久化层。
 * coordinator 不自行保存 JSON，也不把 Worker 的文本当作成功依据；事务边界由宿主回调实现。
 */
export function createProjectWorkerRunCoordinator(
  options: ProjectWorkerRunCoordinatorOptions,
): ProjectWorkerRunCoordinator {
  const projectId = options.projectId.trim();
  if (!projectId) throw new Error('项目 id 不能为空');
  const runsById = new Map(options.runs.map((run) => [run.runId, run]));

  return {
    async run(runId: string): Promise<WorkerRunQueueState> {
      const expected = runsById.get(runId);
      if (!expected) throw new Error(`当前项目不存在 Worker Run：${runId}`);
      if (expected.projectId !== projectId) throw new Error(`Worker Run 不属于当前项目：${runId}`);
      await options.assertConsistency?.();
      return runActiveWorkerRun(
        runId,
        {
          allocator: options.allocator,
          executor: options.executor,
          concurrency: options.concurrency,
          sideEffects: options.sideEffects,
        },
        async ({ state, events }) => {
          if (state.projectId !== projectId) {
            throw new Error(`Worker transition 不属于当前项目：${state.projectId}`);
          }
          await options.persistTransition({ projectId, state, events });
        },
      );
    },
  };
}
