import {
  appendDomainEvent,
  type DomainEvent,
  type RunProjectionStatus,
  type SideEffectRecord,
  type TaskProjectionStatus,
} from './contracts';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';
import { createContextPack, type ContextPack, type FeedbackRequest } from '../projectControl/protocol';
import {
  createAttemptId,
  createTaskExecutionId,
  parseAttemptId,
  type AttemptId,
  type TaskExecutionId,
} from './execution';

export interface WorkerWorktreeAssignment {
  worktreeId: string;
  path: string;
  branch: string;
  baseRevision: string;
}

export interface WorkerDependencyArtifact {
  taskId: string;
  attempt: number;
  worktreeId?: string;
  path: string;
  branch?: string;
  baseRevision?: string;
  branchRevision?: string;
}

export interface WorkerWorktreeAllocator {
  allocate(input: {
    projectId: string;
    runId: string;
    task: ProjectTask;
    attempt: number;
    taskExecutionId: TaskExecutionId;
    attemptId: AttemptId;
    signal?: AbortSignal;
  }): Promise<WorkerWorktreeAssignment>;
}

export interface WorkerTaskLease {
  projectId: string;
  runId: string;
  orchestrationId?: string;
  task: ProjectTask;
  assignment: WorkerWorktreeAssignment;
  attempt: number;
  taskExecutionId: TaskExecutionId;
  attemptId: AttemptId;
  contextPack?: ContextPack;
  /** Read-only references to successful dependency worktrees. */
  dependencyArtifacts?: readonly WorkerDependencyArtifact[];
}

export interface WorkerExecutionResult {
  status: 'succeeded' | 'failed' | 'waiting-feedback';
  error?: string;
  feedbackRequest?: FeedbackRequest;
  evidenceIds?: string[];
  acceptanceId?: string;
}

export interface WorkerExecutor {
  execute(lease: WorkerTaskLease, options?: { signal?: AbortSignal }): Promise<WorkerExecutionResult>;
}

export interface WorkerSideEffectClaim {
  record: SideEffectRecord;
  claimed: boolean;
}

/** Host-owned receipt boundary around a Worker execution side effect. */
export interface WorkerSideEffectRecorder {
  start(lease: WorkerTaskLease): Promise<SideEffectRecord>;
  claim?(lease: WorkerTaskLease): Promise<WorkerSideEffectClaim>;
  complete(record: SideEffectRecord, result: WorkerExecutionResult): Promise<SideEffectRecord>;
  markUnknown?(record: SideEffectRecord, reason: string): Promise<SideEffectRecord>;
}

export type WorkerWorktreeStatus = 'created' | 'cleaned' | 'orphaned' | 'registration-pending';

export interface WorkerQueueTask {
  taskId: string;
  /** Host Acceptance stage expected for this task; defaults to taskId. */
  acceptanceStageId?: string;
  /** Version of the TaskDefinition used to derive side-effect inputHash. */
  taskDefinitionVersion?: 1;
  /** Stable identity of this task definition within the current Run. */
  taskExecutionId?: TaskExecutionId;
  status: TaskProjectionStatus;
  attempt: number;
  /** Retry attempt reserved by recovery before the next claim. */
  pendingAttempt?: number;
  currentAttemptId?: AttemptId;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  baseRevision?: string;
  worktreeStatus?: WorkerWorktreeStatus;
  branchRevision?: string;
  cleanupStateSignature?: string;
  evidenceIds: string[];
  contextPackId?: string;
  contextPackVersion?: number;
  feedbackId?: string;
  acceptanceId?: string;
  cleanupStatus?: 'cleaned';
  cleanupReceiptId?: string;
  error?: string;
  updatedAt: string;
}

export interface WorkerRunQueueState {
  version: 1;
  projectId: string;
  runId: string;
  orchestrationId?: string;
  taskGraphId: string;
  taskGraphVersion: number;
  status: RunProjectionStatus;
  createdAt: string;
  updatedAt: string;
  tasks: Record<string, WorkerQueueTask>;
}

export interface CreateWorkerRunQueueInput {
  projectId: string;
  runId: string;
  orchestrationId?: string;
  taskGraph: ProjectTaskGraph;
  contextPacks?: readonly ContextPack[];
  requireContextPack?: boolean;
  now: string;
}

export interface RestoreWorkerRunQueueInput {
  taskGraph: ProjectTaskGraph;
  state: WorkerRunQueueState;
  contextPacks?: readonly ContextPack[];
  requireContextPack?: boolean;
}

export interface RunWorkerQueueOptions {
  allocator: WorkerWorktreeAllocator;
  executor: WorkerExecutor;
  /** 并发 worker 数；缺省为所有当前可运行任务。 */
  concurrency?: number;
  /** 每个并发 batch 完成后，把最新状态与新事实交给持久层。 */
  onTransition?: (update: { state: WorkerRunQueueState; events: DomainEvent[] }) => Promise<void> | void;
  /** 可选：在 executor 前后记录 Worker side-effect receipt。 */
  sideEffects?: WorkerSideEffectRecorder;
  signal?: AbortSignal;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function workerPathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function resolveWorkerAcceptanceStageId(
  taskId: string,
  acceptanceStageId?: string,
): string | undefined {
  const fallback = taskId.trim();
  if (!fallback) return undefined;
  if (acceptanceStageId === undefined) return fallback;
  const normalized = acceptanceStageId.trim();
  return normalized || undefined;
}

function cloneTask(task: ProjectTask): ProjectTask {
  return {
    ...task,
    scope: [...task.scope],
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: [...task.acceptanceCriteria],
  };
}

function cloneContextPack(pack: ContextPack): ContextPack {
  return createContextPack(pack);
}

function contextPackMap(
  projectId: string,
  runId: string,
  taskGraph: ProjectTaskGraph,
  packs: readonly ContextPack[],
): ReadonlyMap<string, ContextPack> {
  const byTask = new Map<string, ContextPack>();
  for (const pack of packs) {
    const normalized = cloneContextPack(pack);
    if (normalized.projectId !== projectId) {
      throw new Error(`ContextPack 不属于当前 project：${normalized.contextPackId}`);
    }
    if (!taskGraph.tasks.some((task) => task.id === normalized.taskId)) {
      throw new Error(`ContextPack 绑定了不存在的 Task：${normalized.taskId}`);
    }
    const expectedTaskExecutionId = createTaskExecutionId(runId, normalized.taskId);
    if (normalized.taskExecutionId !== expectedTaskExecutionId) {
      throw new Error(`ContextPack 与 run/task execution lineage 不一致：${normalized.contextPackId}`);
    }
    const parsedAttempt = parseAttemptId(normalized.attemptId);
    if (parsedAttempt.taskExecutionId !== expectedTaskExecutionId) {
      throw new Error(`ContextPack 与 task execution/attempt 不一致：${normalized.contextPackId}`);
    }
    if (byTask.has(normalized.taskId)) {
      throw new Error(`同一 Task 不能绑定多个 ContextPack：${normalized.taskId}`);
    }
    byTask.set(normalized.taskId, normalized);
  }
  return byTask;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Worker queue 已取消');
  error.name = 'AbortError';
  throw error;
}

function taskState(
  taskId: string,
  runId: string,
  now: string,
  taskDefinitionVersion: 1,
  acceptanceStageId?: string,
  contextPack?: ContextPack,
): WorkerQueueTask {
  return {
    taskId,
    ...(acceptanceStageId === undefined ? {} : { acceptanceStageId }),
    taskDefinitionVersion,
    ...(contextPack ? {
      contextPackId: contextPack.contextPackId,
      contextPackVersion: contextPack.contextVersion,
    } : {}),
    taskExecutionId: createTaskExecutionId(runId, taskId),
    status: 'queued',
    attempt: 0,
    evidenceIds: [],
    updatedAt: now,
  };
}

function cloneQueueTask(task: WorkerQueueTask): WorkerQueueTask {
  return { ...task, evidenceIds: [...task.evidenceIds] };
}

function normalizeQueueTask(
  task: WorkerQueueTask,
  runId: string,
): WorkerQueueTask {
  const expected = createTaskExecutionId(runId, task.taskId);
  const acceptanceStageId = resolveWorkerAcceptanceStageId(task.taskId, task.acceptanceStageId);
  if (!acceptanceStageId) {
    throw new Error(`Worker Task acceptanceStageId 无效：${task.taskId}`);
  }
  if (task.taskExecutionId && task.taskExecutionId !== expected) {
    throw new Error(`Worker Task lineage 与 Run/task 不一致：${task.taskId}`);
  }
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 0) {
    throw new Error(`Worker Task 的 attempt 无效：${task.taskId}`);
  }
  if ((task.status === 'running' || task.status === 'waiting-feedback' || task.status === 'succeeded' || task.status === 'failed')
    && task.attempt < 1) {
    throw new Error(`Worker Task 的 attempt 无效：${task.taskId}`);
  }
  if (task.status === 'waiting-feedback' && !task.feedbackId?.trim()) {
    throw new Error(`waiting-feedback Worker Task 缺少 feedbackId：${task.taskId}`);
  }
  if (task.status !== 'waiting-feedback' && task.feedbackId !== undefined) {
    throw new Error(`非 waiting-feedback Worker Task 不能携带 feedbackId：${task.taskId}`);
  }
  if (task.worktreeStatus !== undefined
    && !['created', 'cleaned', 'orphaned', 'registration-pending'].includes(task.worktreeStatus)) {
    throw new Error(`Worker Task worktreeStatus 无效：${task.taskId}`);
  }
  if ((task.worktreeStatus === 'orphaned' || task.worktreeStatus === 'registration-pending')
    && !task.branchRevision?.trim()) {
    throw new Error(`Worker Task ${task.worktreeStatus} 缺少 branchRevision：${task.taskId}`);
  }
  if (task.cleanupStatus !== undefined) {
    if (task.cleanupStatus !== 'cleaned') {
      throw new Error(`Worker Task cleanupStatus 无效：${task.taskId}`);
    }
    if (task.status !== 'succeeded' || task.worktreeStatus !== 'cleaned' || !task.cleanupReceiptId?.trim()) {
      throw new Error(`Worker Task cleaned 状态缺少 cleanup receipt：${task.taskId}`);
    }
  }
  if (task.worktreeStatus === 'cleaned' && task.cleanupStatus !== 'cleaned') {
    throw new Error(`Worker Task cleaned 状态缺少 cleanup receipt：${task.taskId}`);
  }
  if (task.status === 'succeeded') {
    if (!Array.isArray(task.evidenceIds) || task.evidenceIds.length === 0) {
      throw new Error(`succeeded Worker Task 缺少非空 Evidence ids：${task.taskId}`);
    }
    const evidenceIds = task.evidenceIds.map((id) => requiredText(id, 'Evidence id'));
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error(`succeeded Worker Task 的 Evidence ids 重复：${task.taskId}`);
    }
  }
  if (task.pendingAttempt !== undefined) {
    if (!Number.isSafeInteger(task.pendingAttempt) || task.pendingAttempt !== task.attempt + 1 || task.status !== 'queued') {
      throw new Error(`Worker Task pendingAttempt 无效：${task.taskId}`);
    }
    if (task.currentAttemptId) throw new Error(`queued retry 不能保留 currentAttemptId：${task.taskId}`);
  }
  if (task.currentAttemptId) {
    const parsed = parseAttemptId(task.currentAttemptId);
    if (parsed.taskExecutionId !== expected || parsed.attempt !== task.attempt) {
      throw new Error(`Worker Task currentAttemptId 与 execution/attempt 不一致：${task.taskId}`);
    }
  }
  const currentAttemptId = task.currentAttemptId
    ?? ((task.status === 'running' || task.status === 'waiting-feedback') && task.attempt > 0
      ? createAttemptId(expected, task.attempt)
      : undefined);
  return cloneQueueTask({
    ...task,
    ...(task.acceptanceStageId === undefined ? {} : { acceptanceStageId }),
    taskExecutionId: expected,
    currentAttemptId,
  });
}

function validateGraph(taskGraph: ProjectTaskGraph): void {
  if (taskGraph.approval !== 'approved') {
    throw new Error(`任务图尚未批准，不能创建 Worker 队列：${taskGraph.approval}`);
  }
  if (taskGraph.tasks.length === 0) throw new Error('任务图不能为空');
  const ids = new Set<string>();
  for (const task of taskGraph.tasks) {
    if (ids.has(task.id)) throw new Error(`任务图中的任务 id 不能重复：${task.id}`);
    ids.add(task.id);
  }
  for (const task of taskGraph.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`任务 ${task.id} 依赖不存在的任务：${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`任务图存在循环依赖：${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = taskGraph.tasks.find((item) => item.id === taskId)!;
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of taskGraph.tasks) visit(task.id);
}

export class WorkerTaskQueue {
  private readonly tasksById: ReadonlyMap<string, ProjectTask>;
  private readonly contextPacksByTask: ReadonlyMap<string, ContextPack>;
  private readonly requireContextPack: boolean;
  private state: WorkerRunQueueState;
  private events: DomainEvent[] = [];
  private runStartedEmitted = false;
  private readonly claiming = new Set<string>();

  constructor(
    private readonly taskGraph: ProjectTaskGraph,
    initialState: WorkerRunQueueState,
    emitInitialEvents = false,
    contextPacks: readonly ContextPack[] = [],
    requireContextPack = false,
  ) {
    validateGraph(taskGraph);
    this.tasksById = new Map(taskGraph.tasks.map((task) => [task.id, task]));
    this.contextPacksByTask = contextPackMap(initialState.projectId, initialState.runId, taskGraph, contextPacks);
    this.requireContextPack = requireContextPack
      || Object.values(initialState.tasks).some((task) => task.contextPackId !== undefined);
    this.state = {
      ...initialState,
      tasks: Object.fromEntries(
        Object.entries(initialState.tasks).map(([id, task]) => {
          if (task.taskId !== id) {
            throw new Error(`Worker Task state key 与 taskId 不一致：${id}/${task.taskId}`);
          }
          const taskDefinition = this.tasksById.get(id);
          const expectedStageId = resolveWorkerAcceptanceStageId(id, taskDefinition?.stageId);
          const persistedStageId = task.acceptanceStageId === undefined
            ? expectedStageId
            : resolveWorkerAcceptanceStageId(id, task.acceptanceStageId);
          if (!expectedStageId || persistedStageId !== expectedStageId) {
            throw new Error(`Worker Task acceptance stage 与 TaskGraph 不一致：${id}`);
          }
          const contextPack = this.contextPacksByTask.get(id);
          if (this.requireContextPack && !contextPack) {
            throw new Error(`hierarchical Worker 缺少 ContextPack：${id}`);
          }
          if (task.contextPackId !== undefined
            && (!contextPack || task.contextPackId !== contextPack.contextPackId
              || task.contextPackVersion !== contextPack.contextVersion)) {
            throw new Error(`Worker Task ContextPack binding 不一致：${id}`);
          }
          if (contextPack) {
            const expectedContextAttempt = task.status === 'queued'
              ? (task.pendingAttempt ?? task.attempt + 1)
              : task.attempt;
            if (expectedContextAttempt > 0
              && task.status !== 'blocked'
              && task.status !== 'cancelled'
              && contextPack.attemptId !== createAttemptId(
                contextPack.taskExecutionId,
                expectedContextAttempt,
              )) {
              throw new Error(`ContextPack 与 Worker attempt 不一致：${id}`);
            }
          }
          const normalized = normalizeQueueTask(
            {
              ...task,
              acceptanceStageId: expectedStageId,
              taskDefinitionVersion: task.taskDefinitionVersion ?? taskDefinition?.version,
            },
            initialState.runId,
          );
          return [id, {
            ...normalized,
            ...(contextPack ? {
              contextPackId: contextPack.contextPackId,
              contextPackVersion: contextPack.contextVersion,
            } : {}),
          }] as const;
        }),
      ),
    };
    this.runStartedEmitted = initialState.status !== 'queued';
    this.validateState();
    if (emitInitialEvents) {
      this.emitRun('RunCreated', {
        runId: this.state.runId,
        orchestrationId: this.state.orchestrationId,
        taskGraphId: this.state.taskGraphId,
        taskGraphVersion: this.state.taskGraphVersion,
        taskIds: this.taskGraph.tasks.map((task) => task.id),
      }, this.state.createdAt);
      for (const task of this.taskGraph.tasks) {
        this.emitTask('TaskQueued', task.id, {
          runId: this.state.runId,
          taskGraphId: this.state.taskGraphId,
        }, this.state.createdAt);
      }
    }
  }

  snapshot(): WorkerRunQueueState {
    return {
      ...this.state,
      tasks: Object.fromEntries(
        Object.entries(this.state.tasks).map(([id, task]) => [id, cloneQueueTask(task)]),
      ),
    };
  }

  getTask(taskId: string): ProjectTask | undefined {
    const task = this.tasksById.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  drainEvents(): DomainEvent[] {
    const drained = [...this.events];
    this.events = [];
    return drained;
  }

  restoreEvents(events: readonly DomainEvent[]): void {
    this.events = [...events, ...this.events];
  }

  runnableTaskIds(): string[] {
    this.reconcileBlocked(this.state.updatedAt);
    return this.taskGraph.tasks
      .filter((task) => {
        const current = this.state.tasks[task.id];
        return current.status === 'queued' && task.dependsOn.every(
          (dependency) => this.state.tasks[dependency]?.status === 'succeeded',
        );
      })
      .map((task) => task.id);
  }

  async claimTask(
    taskId: string,
    allocator: WorkerWorktreeAllocator,
    signal?: AbortSignal,
  ): Promise<WorkerTaskLease | null> {
    throwIfAborted(signal);
    this.reconcileBlocked(this.state.updatedAt);
    const task = this.tasksById.get(taskId);
    const current = this.state.tasks[taskId];
    if (!task || !current) throw new Error(`队列中不存在任务：${taskId}`);
    if (current.status !== 'queued') {
      throw new Error(`任务当前不可 claim：${taskId} (${current.status})`);
    }
    if (!task.dependsOn.every((dependency) => this.state.tasks[dependency]?.status === 'succeeded')) {
      throw new Error(`任务依赖尚未完成，不能 claim：${taskId}`);
    }
    if (this.claiming.has(taskId)) throw new Error(`任务正在 claim：${taskId}`);
    const attempt = current.pendingAttempt ?? current.attempt + 1;
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const attemptId = createAttemptId(taskExecutionId, attempt);
    const contextPack = this.contextPacksByTask.get(taskId);
    const dependencyArtifacts = task.dependsOn.flatMap((dependencyId): WorkerDependencyArtifact[] => {
      const dependency = this.state.tasks[dependencyId];
      if (!dependency || dependency.status !== 'succeeded' || !dependency.worktreePath) return [];
      return [{
        taskId: dependencyId,
        attempt: dependency.attempt,
        ...(dependency.worktreeId ? { worktreeId: dependency.worktreeId } : {}),
        path: dependency.worktreePath,
        ...(dependency.branch ? { branch: dependency.branch } : {}),
        ...(dependency.baseRevision ? { baseRevision: dependency.baseRevision } : {}),
        ...(dependency.branchRevision ? { branchRevision: dependency.branchRevision } : {}),
      }];
    });
    if (this.requireContextPack && !contextPack) {
      throw new Error(`hierarchical Worker claim 缺少 ContextPack：${taskId}`);
    }
    if (contextPack && contextPack.attemptId !== attemptId) {
      throw new Error(`ContextPack 与当前 claim Attempt 不一致：${taskId}`);
    }
    this.claiming.add(taskId);
    try {
      const assignment = await allocator.allocate({
        projectId: this.state.projectId,
        runId: this.state.runId,
        task: cloneTask(task),
        attempt,
        taskExecutionId,
        attemptId,
        signal,
      });
      throwIfAborted(signal);
      const reusedBy = Object.values(this.state.tasks).find(
        (item) => item.taskId !== taskId
          && (item.worktreeId === assignment.worktreeId
            || (item.worktreePath !== undefined && workerPathKey(item.worktreePath) === workerPathKey(assignment.path))),
      );
      if (reusedBy) {
        throw new Error(`worktree 已被任务 ${reusedBy.taskId} 占用，拒绝复用`);
      }
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        status: 'running',
        updatedAt: now,
        tasks: {
          ...this.state.tasks,
          [taskId]: {
            ...current,
            taskExecutionId,
            currentAttemptId: attemptId,
            status: 'running',
            attempt,
            pendingAttempt: undefined,
            worktreeId: requiredText(assignment.worktreeId, 'worktree id'),
            worktreePath: requiredText(assignment.path, 'worktree 路径'),
            branch: requiredText(assignment.branch, 'worktree 分支'),
            baseRevision: requiredText(assignment.baseRevision, 'worktree 基线'),
            worktreeStatus: 'created',
            branchRevision: undefined,
            cleanupStateSignature: undefined,
            updatedAt: now,
          },
        },
      };
      if (!this.runStartedEmitted) {
        this.emitRun('RunStarted', { runId: this.state.runId }, now);
      }
      this.emitTask('TaskStarted', taskId, {
        runId: this.state.runId,
        taskId,
        taskExecutionId,
        attemptId,
        worktreeId: assignment.worktreeId,
        worktreePath: assignment.path,
        branch: assignment.branch,
        baseRevision: assignment.baseRevision,
        worktreeStatus: 'created',
        branchRevision: undefined,
        attempt,
      }, now);
      return {
        projectId: this.state.projectId,
        runId: this.state.runId,
        orchestrationId: this.state.orchestrationId,
        task: cloneTask(task),
        assignment,
        attempt,
        taskExecutionId,
        attemptId,
        ...(contextPack ? { contextPack: cloneContextPack(contextPack) } : {}),
        ...(dependencyArtifacts.length > 0 ? { dependencyArtifacts } : {}),
      };
    } catch (cause) {
      if (signal?.aborted) throwIfAborted(signal);
      const now = new Date().toISOString();
      const message = `worktree 分配失败：${errorMessage(cause)}`;
      this.state = {
        ...this.state,
        status: 'running',
        updatedAt: now,
        tasks: {
          ...this.state.tasks,
          [taskId]: {
            ...current,
            taskExecutionId,
            currentAttemptId: attemptId,
            status: 'running',
            attempt,
            pendingAttempt: undefined,
            updatedAt: now,
          },
        },
      };
      if (!this.runStartedEmitted) {
        this.emitRun('RunStarted', { runId: this.state.runId }, now);
      }
      this.emitTask('TaskStarted', taskId, {
        runId: this.state.runId,
        taskId,
        taskExecutionId,
        attemptId,
        attempt,
      }, now);
      this.state = {
        ...this.state,
        updatedAt: now,
        tasks: {
          ...this.state.tasks,
          [taskId]: {
            ...current,
            taskExecutionId,
            currentAttemptId: attemptId,
            status: 'failed',
            attempt,
            pendingAttempt: undefined,
            error: message,
            updatedAt: now,
          },
        },
      };
      this.emitTask('TaskFailed', taskId, {
        runId: this.state.runId,
        taskId,
        taskExecutionId,
        attemptId,
        error: message,
        attempt,
      }, now);
      this.reconcileBlocked(now);
      this.recomputeRunStatus(now);
      return null;
    } finally {
      this.claiming.delete(taskId);
    }
  }

  markSucceeded(
    taskId: string,
    evidenceIds: string[],
    now: string,
    acceptanceId: string | undefined,
    expectedAttemptId: AttemptId,
  ): void {
    const current = this.requireRunning(taskId, expectedAttemptId);
    const uniqueEvidenceIds = [...new Set(evidenceIds.map((id) => requiredText(id, 'Evidence id')))];
    if (uniqueEvidenceIds.length === 0) {
      throw new Error(`succeeded Worker Task 缺少非空 Evidence ids：${taskId}`);
    }
    this.state = {
      ...this.state,
      updatedAt: now,
      tasks: {
        ...this.state.tasks,
        [taskId]: {
          ...current,
          status: 'succeeded',
          evidenceIds: uniqueEvidenceIds,
          ...(acceptanceId ? { acceptanceId: requiredText(acceptanceId, 'acceptance id') } : {}),
          error: undefined,
          updatedAt: now,
        },
      },
    };
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const attemptId = current.currentAttemptId ?? createAttemptId(taskExecutionId, current.attempt);
    this.emitTask('TaskSucceeded', taskId, {
      runId: this.state.runId,
      taskId,
      taskExecutionId,
      attemptId,
      attempt: current.attempt,
      evidenceIds: uniqueEvidenceIds,
      ...(acceptanceId ? { acceptanceId } : {}),
      worktreeId: current.worktreeId,
    }, now);
    this.reconcileBlocked(now);
    this.recomputeRunStatus(now);
  }

  markFailed(
    taskId: string,
    error: string,
    now: string,
    evidenceIds: string[],
    acceptanceId: string | undefined,
    expectedAttemptId: AttemptId,
  ): void {
    const current = this.requireRunning(taskId, expectedAttemptId);
    const message = requiredText(error, '失败原因');
    const uniqueEvidenceIds = [...new Set(evidenceIds.map((id) => requiredText(id, 'Evidence id')))];
    const normalizedAcceptanceId = acceptanceId?.trim()
      ? requiredText(acceptanceId, 'acceptance id')
      : undefined;
    this.state = {
      ...this.state,
      updatedAt: now,
      tasks: {
        ...this.state.tasks,
        [taskId]: {
          ...current,
          status: 'failed',
          evidenceIds: uniqueEvidenceIds,
          ...(normalizedAcceptanceId ? { acceptanceId: normalizedAcceptanceId } : {}),
          error: message,
          updatedAt: now,
        },
      },
    };
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const attemptId = current.currentAttemptId ?? createAttemptId(taskExecutionId, current.attempt);
    this.emitTask('TaskFailed', taskId, {
      runId: this.state.runId,
      taskId,
      taskExecutionId,
      attemptId,
      error: message,
      attempt: current.attempt,
      ...(uniqueEvidenceIds.length > 0 ? { evidenceIds: uniqueEvidenceIds } : {}),
      ...(normalizedAcceptanceId ? { acceptanceId: normalizedAcceptanceId } : {}),
    }, now);
    this.reconcileBlocked(now);
    this.recomputeRunStatus(now);
  }

  markWaitingFeedback(
    taskId: string,
    request: FeedbackRequest,
    now: string,
    expectedAttemptId: AttemptId,
  ): void {
    const current = this.requireRunning(taskId, expectedAttemptId);
    const feedbackId = requiredText(request.feedbackId, 'feedback id');
    if (!request.blocking) throw new Error(`非 blocking FeedbackRequest 不能暂停 Worker：${feedbackId}`);
    if (request.projectId !== this.state.projectId || request.taskId !== taskId) {
      throw new Error(`FeedbackRequest 不属于当前项目或 Task：${feedbackId}`);
    }
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const attemptId = current.currentAttemptId ?? createAttemptId(taskExecutionId, current.attempt);
    if (request.attemptId !== attemptId) {
      throw new Error(`FeedbackRequest 与当前 Attempt 不一致：${feedbackId}`);
    }
    this.state = {
      ...this.state,
      status: 'blocked',
      updatedAt: now,
      tasks: {
        ...this.state.tasks,
        [taskId]: {
          ...current,
          status: 'waiting-feedback',
          feedbackId,
          error: undefined,
          updatedAt: now,
        },
      },
    };
    this.emitTask('TaskFeedbackRequested', taskId, {
      ...request,
      runId: this.state.runId,
      taskId,
      taskExecutionId,
      attemptId,
      attempt: current.attempt,
    }, now);
    this.recomputeRunStatus(now);
  }

  private requireRunning(taskId: string, expectedAttemptId: AttemptId): WorkerQueueTask {
    const current = this.state.tasks[taskId];
    if (!current) throw new Error(`队列中不存在任务：${taskId}`);
    if (current.status !== 'running') {
      throw new Error(`任务当前不是 running：${taskId} (${current.status})`);
    }
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const currentAttemptId = current.currentAttemptId
      ?? createAttemptId(taskExecutionId, current.attempt);
    if (currentAttemptId !== expectedAttemptId) {
      throw new Error(`拒绝过期 Worker Attempt completion：${taskId} (${expectedAttemptId})`);
    }
    return current;
  }

  private reconcileBlocked(now: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.taskGraph.tasks) {
        const current = this.state.tasks[task.id];
        if (current.status !== 'queued') continue;
        const blockedBy = task.dependsOn.filter((dependency) => {
          const status = this.state.tasks[dependency]?.status;
          return status === 'failed' || status === 'blocked' || status === 'cancelled';
        });
        if (blockedBy.length === 0) continue;
        const message = `依赖任务未成功完成：${blockedBy.join(', ')}`;
        this.state = {
          ...this.state,
          updatedAt: now,
          tasks: {
            ...this.state.tasks,
            [task.id]: { ...current, status: 'blocked', error: message, updatedAt: now },
          },
        };
        this.emitTask('TaskBlocked', task.id, {
          runId: this.state.runId,
          taskId: task.id,
          taskExecutionId: this.state.tasks[task.id].taskExecutionId,
          blockedBy,
          reason: message,
        }, now);
        changed = true;
      }
    }
  }

  private recomputeRunStatus(now: string): void {
    const statuses = Object.values(this.state.tasks).map((task) => task.status);
    const next: RunProjectionStatus = statuses.every((status) => status === 'succeeded')
      ? 'succeeded'
      : statuses.some((status) => status === 'running')
        ? 'running'
        : statuses.some((status) => status === 'failed')
          ? 'partial'
          : statuses.some((status) => status === 'waiting-feedback')
            ? 'blocked'
            : statuses.some((status) => status === 'blocked')
            ? 'blocked'
            : statuses.some((status) => status === 'cancelled')
              ? 'cancelled'
              : 'queued';
    if (next === this.state.status) return;
    this.state = { ...this.state, status: next, updatedAt: now };
    const eventType: Record<RunProjectionStatus, string | undefined> = {
      queued: undefined,
      running: 'RunStarted',
      partial: 'RunPartial',
      blocked: 'RunBlocked',
      failed: 'RunFailed',
      cancelled: 'RunCancelled',
      succeeded: 'RunSucceeded',
    };
    const type = eventType[next];
    if (type && !(type === 'RunStarted' && this.runStartedEmitted)) {
      this.emitRun(type, { runId: this.state.runId, taskGraphId: this.state.taskGraphId }, now);
    }
  }

  private emitRun(eventType: string, payload: unknown, occurredAt: string): void {
    if (eventType === 'RunStarted') this.runStartedEmitted = true;
    this.emit({
      eventId: `${this.state.runId}:${eventType}:attempt-${this.maxAttempt()}:${this.events.length + 1}`,
      streamId: this.state.projectId,
      aggregateType: 'Run',
      aggregateId: this.state.runId,
      eventType,
      schemaVersion: 1,
      payload,
      actor: 'runtime',
      occurredAt,
      correlationId: this.state.runId,
      source: { objectId: this.state.taskGraphId, objectVersion: this.state.taskGraphVersion },
      sensitivity: 'normal',
    });
  }

  private emitTask(eventType: string, taskId: string, payload: unknown, occurredAt: string): void {
    const current = this.state.tasks[taskId];
    const taskExecutionId = current.taskExecutionId ?? createTaskExecutionId(this.state.runId, taskId);
    const payloadRecord = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const enrichedPayload = { ...payloadRecord, taskId, taskExecutionId } as Record<string, unknown>;
    const attemptId = typeof payloadRecord.attemptId === 'string'
      ? payloadRecord.attemptId
      : 'none';
    this.emit({
      eventId: `${taskExecutionId}:${eventType}:${attemptId}:${this.events.length + 1}`,
      streamId: this.state.projectId,
      aggregateType: 'TaskExecution',
      aggregateId: taskExecutionId,
      eventType,
      schemaVersion: 1,
      payload: enrichedPayload,
      actor: 'runtime',
      occurredAt,
      correlationId: this.state.runId,
      source: { objectId: this.state.taskGraphId, objectVersion: this.state.taskGraphVersion },
      sensitivity: 'normal',
    });
  }

  private maxAttempt(): number {
    return Object.values(this.state.tasks).reduce(
      (max, task) => Math.max(max, task.attempt),
      0,
    );
  }

  private emit(event: Omit<DomainEvent, 'sequence' | 'aggregateVersion'>): void {
    const previous = [...this.events]
      .reverse()
      .find((item) => item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId);
    const next: DomainEvent = {
      ...event,
      sequence: this.events.length + 1,
      aggregateVersion: (previous?.aggregateVersion ?? 0) + 1,
    };
    this.events = appendDomainEvent(this.events, next);
  }

  private validateState(): void {
    const taskIds = new Set(this.taskGraph.tasks.map((task) => task.id));
    const stateIds = new Set(Object.keys(this.state.tasks));
    if (this.state.version !== 1) throw new Error(`不支持的 Worker 队列版本：${this.state.version}`);
    if (!this.state.projectId || !this.state.runId || !this.state.taskGraphId) {
      throw new Error('Worker 队列缺少 projectId/runId/taskGraphId');
    }
    if (this.state.taskGraphId !== this.taskGraph.id || this.state.taskGraphVersion !== this.taskGraph.graphVersion) {
      throw new Error('Worker 队列与任务图版本不一致，拒绝恢复');
    }
    if (taskIds.size !== stateIds.size || [...taskIds].some((id) => !stateIds.has(id))) {
      throw new Error('Worker 队列任务集合与任务图不一致，拒绝恢复');
    }
  }
}

export function createWorkerRunQueue(input: CreateWorkerRunQueueInput): WorkerTaskQueue {
  const projectId = requiredText(input.projectId, '项目 id');
  const runId = requiredText(input.runId, 'Run id');
  const now = requiredText(input.now, '时间');
  validateGraph(input.taskGraph);
  const contextPacks = input.contextPacks ?? [];
  const contextPacksByTask = contextPackMap(projectId, runId, input.taskGraph, contextPacks);
  if (input.requireContextPack && input.taskGraph.tasks.some((task) => !contextPacksByTask.has(task.id))) {
    throw new Error('hierarchical Worker queue 的每个 Task 都必须有 ContextPack');
  }
  const state: WorkerRunQueueState = {
    version: 1,
    projectId,
    runId,
    ...(input.orchestrationId ? { orchestrationId: input.orchestrationId } : {}),
    taskGraphId: input.taskGraph.id,
    taskGraphVersion: input.taskGraph.graphVersion,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    tasks: Object.fromEntries(input.taskGraph.tasks.map((task) => [
      task.id,
      taskState(task.id, runId, now, task.version, task.stageId, contextPacksByTask.get(task.id)),
    ])),
  };
  return new WorkerTaskQueue(
    input.taskGraph,
    state,
    true,
    contextPacks,
    input.requireContextPack,
  );
}

export function restoreWorkerRunQueue(input: RestoreWorkerRunQueueInput): WorkerTaskQueue {
  validateGraph(input.taskGraph);
  return new WorkerTaskQueue(
    input.taskGraph,
    input.state,
    false,
    input.contextPacks,
    input.requireContextPack,
  );
}

export async function runWorkerQueue(
  queue: WorkerTaskQueue,
  options: RunWorkerQueueOptions,
): Promise<WorkerRunQueueState> {
  const throwIfCancelled = (): void => throwIfAborted(options.signal);
  const concurrency = options.concurrency === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.floor(options.concurrency));
  const flushTransition = async (forceFinalize = false): Promise<void> => {
    if (!forceFinalize) throwIfCancelled();
    if (!options.onTransition) return;
    const events = queue.drainEvents();
    if (events.length === 0) return;
    try {
      await options.onTransition({ state: queue.snapshot(), events });
    } catch (error) {
      queue.restoreEvents(events);
      throw error;
    }
  };
  while (true) {
    throwIfCancelled();
    const runnable = queue.runnableTaskIds();
    if (runnable.length === 0) {
      await flushTransition();
      return queue.snapshot();
    }
    const batch = runnable.slice(0, concurrency);
    const leases: WorkerTaskLease[] = [];
    await Promise.all(batch.map(async (taskId) => {
      const lease = await queue.claimTask(taskId, options.allocator, options.signal);
      if (lease) leases.push(lease);
    }));
    // 先把 running lease 写入事实源，再允许 Worker 触碰 worktree/外部副作用。
    await flushTransition();
    let terminalizedInBatch = false;
    const settled = await Promise.allSettled(leases.map(async (lease) => {
      const taskId = lease.task.id;
      let sideEffect: SideEffectRecord | undefined;
      try {
        throwIfCancelled();
        const claim = options.sideEffects?.claim
          ? await options.sideEffects.claim(lease)
          : { record: await options.sideEffects?.start(lease), claimed: true };
        let result: WorkerExecutionResult;
        if (!claim.record) {
          throwIfCancelled();
          result = await options.executor.execute(lease, { signal: options.signal });
          throwIfCancelled();
        } else if (!claim.claimed) {
          sideEffect = claim.record;
          if (claim.record.status !== 'receipt' || !claim.record.receipt?.outcome) return;
          if (claim.record.receipt.outcome === 'succeeded' && claim.record.receipt.evidenceIds === undefined) return;
          result = {
            status: claim.record.receipt.outcome,
            error: claim.record.receipt.error,
            evidenceIds: claim.record.receipt.evidenceIds,
            acceptanceId: claim.record.receipt.acceptanceId,
          };
        } else {
          sideEffect = claim.record;
          throwIfCancelled();
          result = await options.executor.execute(lease, { signal: options.signal });
          throwIfCancelled();
          if (result.status === 'waiting-feedback') {
            if (!result.feedbackRequest) throw new Error('waiting-feedback Worker 结果缺少 FeedbackRequest');
            if (!options.sideEffects?.markUnknown) {
              throw new Error('side effect 已 claim，但 Worker feedback 缺少 unknown recovery handler');
            }
            sideEffect = await options.sideEffects.markUnknown(
              sideEffect,
              'worker-requested-feedback-before-terminal-receipt',
            );
          } else {
            const completed = options.sideEffects
              ? await options.sideEffects.complete(sideEffect, result)
              : sideEffect;
            sideEffect = completed;
            if (completed.status !== 'receipt') return;
          }
        }
        if (result.status === 'succeeded') {
          queue.markSucceeded(taskId, result.evidenceIds ?? [], new Date().toISOString(), result.acceptanceId, lease.attemptId);
        } else if (result.status === 'waiting-feedback') {
          if (!result.feedbackRequest) throw new Error('waiting-feedback Worker 结果缺少 FeedbackRequest');
          queue.markWaitingFeedback(taskId, result.feedbackRequest, new Date().toISOString(), lease.attemptId);
        } else {
          queue.markFailed(
            taskId,
            result.error ?? 'Worker 未提供失败原因',
            new Date().toISOString(),
            result.evidenceIds ?? [],
            result.acceptanceId,
            lease.attemptId,
          );
        }
        terminalizedInBatch = true;
      } catch (cause) {
        if (sideEffect && options.sideEffects?.markUnknown) {
          try {
            await options.sideEffects.markUnknown(sideEffect, 'worker-execution-failed-before-receipt');
          } catch {
            // Preserve the task failure; the journal remains an explicit recovery concern.
          }
        }
        if (options.signal?.aborted) throwIfCancelled();
        queue.markFailed(taskId, `Worker 执行异常：${errorMessage(cause)}`, new Date().toISOString(), [], undefined, lease.attemptId);
        terminalizedInBatch = true;
      }
    }));
    await flushTransition(terminalizedInBatch);
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (options.signal?.aborted && terminalizedInBatch) return queue.snapshot();
  }
}
