import {
  appendDomainEvent,
  type DomainEvent,
  type RunProjectionStatus,
  type TaskProjectionStatus,
} from './contracts';
import type { ProjectTask, ProjectTaskGraph } from '../projectControl/types';

export interface WorkerWorktreeAssignment {
  worktreeId: string;
  path: string;
  branch: string;
  baseRevision: string;
}

export interface WorkerWorktreeAllocator {
  allocate(input: {
    projectId: string;
    runId: string;
    task: ProjectTask;
    attempt: number;
  }): Promise<WorkerWorktreeAssignment>;
}

export interface WorkerTaskLease {
  runId: string;
  task: ProjectTask;
  assignment: WorkerWorktreeAssignment;
  attempt: number;
}

export interface WorkerExecutionResult {
  status: 'succeeded' | 'failed';
  error?: string;
  evidenceIds?: string[];
}

export interface WorkerExecutor {
  execute(lease: WorkerTaskLease): Promise<WorkerExecutionResult>;
}

export interface WorkerQueueTask {
  taskId: string;
  status: TaskProjectionStatus;
  attempt: number;
  worktreeId?: string;
  worktreePath?: string;
  baseRevision?: string;
  evidenceIds: string[];
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
  now: string;
}

export interface RestoreWorkerRunQueueInput {
  taskGraph: ProjectTaskGraph;
  state: WorkerRunQueueState;
}

export interface RunWorkerQueueOptions {
  allocator: WorkerWorktreeAllocator;
  executor: WorkerExecutor;
  /** 并发 worker 数；缺省为所有当前可运行任务。 */
  concurrency?: number;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function cloneTask(task: ProjectTask): ProjectTask {
  return {
    ...task,
    scope: [...task.scope],
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: [...task.acceptanceCriteria],
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function taskState(taskId: string, now: string): WorkerQueueTask {
  return {
    taskId,
    status: 'queued',
    attempt: 0,
    evidenceIds: [],
    updatedAt: now,
  };
}

function cloneQueueTask(task: WorkerQueueTask): WorkerQueueTask {
  return { ...task, evidenceIds: [...task.evidenceIds] };
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
  private state: WorkerRunQueueState;
  private events: DomainEvent[] = [];
  private readonly claiming = new Set<string>();

  constructor(
    private readonly taskGraph: ProjectTaskGraph,
    initialState: WorkerRunQueueState,
    emitInitialEvents = false,
  ) {
    validateGraph(taskGraph);
    this.tasksById = new Map(taskGraph.tasks.map((task) => [task.id, task]));
    this.state = {
      ...initialState,
      tasks: Object.fromEntries(
        Object.entries(initialState.tasks).map(([id, task]) => [id, cloneQueueTask(task)]),
      ),
    };
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
  ): Promise<WorkerTaskLease | null> {
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
    this.claiming.add(taskId);
    const attempt = current.attempt + 1;
    try {
      const assignment = await allocator.allocate({
        projectId: this.state.projectId,
        runId: this.state.runId,
        task: cloneTask(task),
        attempt,
      });
      const reusedBy = Object.values(this.state.tasks).find(
        (item) => item.taskId !== taskId
          && (item.worktreeId === assignment.worktreeId || item.worktreePath === assignment.path),
      );
      if (reusedBy) {
        throw new Error(`worktree 已被任务 ${reusedBy.taskId} 占用，拒绝复用`);
      }
      const now = new Date().toISOString();
      const wasRunning = this.state.status === 'running';
      this.state = {
        ...this.state,
        status: 'running',
        updatedAt: now,
        tasks: {
          ...this.state.tasks,
          [taskId]: {
            ...current,
            status: 'running',
            attempt,
            worktreeId: requiredText(assignment.worktreeId, 'worktree id'),
            worktreePath: requiredText(assignment.path, 'worktree 路径'),
            baseRevision: requiredText(assignment.baseRevision, 'worktree 基线'),
            updatedAt: now,
          },
        },
      };
      if (!wasRunning) {
        this.emitRun('RunStarted', { runId: this.state.runId }, now);
      }
      this.emitTask('TaskStarted', taskId, {
        runId: this.state.runId,
        worktreeId: assignment.worktreeId,
        worktreePath: assignment.path,
        baseRevision: assignment.baseRevision,
        attempt,
      }, now);
      return {
        runId: this.state.runId,
        task: cloneTask(task),
        assignment,
        attempt,
      };
    } catch (cause) {
      const now = new Date().toISOString();
      const message = `worktree 分配失败：${errorMessage(cause)}`;
      this.state = {
        ...this.state,
        updatedAt: now,
        tasks: {
          ...this.state.tasks,
          [taskId]: { ...current, status: 'failed', attempt, error: message, updatedAt: now },
        },
      };
      this.emitTask('TaskFailed', taskId, { runId: this.state.runId, error: message, attempt }, now);
      this.reconcileBlocked(now);
      this.recomputeRunStatus(now);
      return null;
    } finally {
      this.claiming.delete(taskId);
    }
  }

  markSucceeded(taskId: string, evidenceIds: string[] = [], now = new Date().toISOString()): void {
    const current = this.requireRunning(taskId);
    const uniqueEvidenceIds = [...new Set(evidenceIds.map((id) => requiredText(id, 'Evidence id')))];
    this.state = {
      ...this.state,
      updatedAt: now,
      tasks: {
        ...this.state.tasks,
        [taskId]: {
          ...current,
          status: 'succeeded',
          evidenceIds: uniqueEvidenceIds,
          error: undefined,
          updatedAt: now,
        },
      },
    };
    this.emitTask('TaskSucceeded', taskId, {
      runId: this.state.runId,
      evidenceIds: uniqueEvidenceIds,
      worktreeId: current.worktreeId,
    }, now);
    this.reconcileBlocked(now);
    this.recomputeRunStatus(now);
  }

  markFailed(taskId: string, error: string, now = new Date().toISOString()): void {
    const current = this.requireRunning(taskId);
    const message = requiredText(error, '失败原因');
    this.state = {
      ...this.state,
      updatedAt: now,
      tasks: {
        ...this.state.tasks,
        [taskId]: { ...current, status: 'failed', error: message, updatedAt: now },
      },
    };
    this.emitTask('TaskFailed', taskId, { runId: this.state.runId, error: message, attempt: current.attempt }, now);
    this.reconcileBlocked(now);
    this.recomputeRunStatus(now);
  }

  private requireRunning(taskId: string): WorkerQueueTask {
    const current = this.state.tasks[taskId];
    if (!current) throw new Error(`队列中不存在任务：${taskId}`);
    if (current.status !== 'running') {
      throw new Error(`任务当前不是 running：${taskId} (${current.status})`);
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
    if (type && !(type === 'RunStarted' && this.events.some((event) => event.eventType === type))) {
      this.emitRun(type, { runId: this.state.runId, taskGraphId: this.state.taskGraphId }, now);
    }
  }

  private emitRun(eventType: string, payload: unknown, occurredAt: string): void {
    this.emit({
      eventId: `${this.state.runId}:${eventType}:${this.events.length + 1}`,
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
    this.emit({
      eventId: `${this.state.runId}:${taskId}:${eventType}:${this.events.length + 1}`,
      streamId: this.state.projectId,
      aggregateType: 'Task',
      aggregateId: taskId,
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
    tasks: Object.fromEntries(input.taskGraph.tasks.map((task) => [task.id, taskState(task.id, now)])),
  };
  return new WorkerTaskQueue(input.taskGraph, state, true);
}

export function restoreWorkerRunQueue(input: RestoreWorkerRunQueueInput): WorkerTaskQueue {
  validateGraph(input.taskGraph);
  return new WorkerTaskQueue(input.taskGraph, input.state, false);
}

export async function runWorkerQueue(
  queue: WorkerTaskQueue,
  options: RunWorkerQueueOptions,
): Promise<WorkerRunQueueState> {
  const concurrency = options.concurrency === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.floor(options.concurrency));
  while (true) {
    const runnable = queue.runnableTaskIds();
    if (runnable.length === 0) return queue.snapshot();
    const batch = runnable.slice(0, concurrency);
    await Promise.all(batch.map(async (taskId) => {
      const lease = await queue.claimTask(taskId, options.allocator);
      if (!lease) return;
      try {
        const result = await options.executor.execute(lease);
        if (result.status === 'succeeded') {
          queue.markSucceeded(taskId, result.evidenceIds ?? []);
        } else {
          queue.markFailed(taskId, result.error ?? 'Worker 未提供失败原因');
        }
      } catch (cause) {
        queue.markFailed(taskId, `Worker 执行异常：${errorMessage(cause)}`);
      }
    }));
  }
}
