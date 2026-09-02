import {
  completeSideEffect,
  createSideEffect,
  startSideEffect,
  type SideEffectRecord,
} from '../domain/contracts';
import {
  recoverInterruptedSideEffect,
  SideEffectJournalError,
  SideEffectJournalRepository,
  type SideEffectJournal,
} from '../domain/sideEffects';
import type {
  WorkerExecutionResult,
  WorkerRunQueueState,
  WorkerSideEffectRecorder,
  WorkerTaskLease,
} from '../domain/workerQueue';
import { restoreWorkerRunQueue } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';

export type WorkerRunRecoveryDecision = 'inspect' | 'retry' | 'skip';

export interface WorkerRunRecoveryPlan {
  runId: string;
  effects: SideEffectRecord[];
  effectKeys: string[];
  requiresUser: boolean;
  allowedDecisions: readonly WorkerRunRecoveryDecision[];
}

export interface AppliedWorkerRunRecoveryDecision {
  runId: string;
  decision: WorkerRunRecoveryDecision;
  reason: string;
  effectKeys: string[];
  /** retry 必须由上层创建新的 attempt/worktree；绝不复用旧 idempotency key。 */
  requiresNewAttempt: boolean;
}

export type WorkerSideEffectClock = () => string;

export interface WorkerSideEffectRecorderWithRecovery extends WorkerSideEffectRecorder {
  recoverInterruptedRun(runId: string): Promise<SideEffectJournal>;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function entryFor(journal: SideEffectJournal, idempotencyKey: string): SideEffectRecord {
  const entry = journal.entries.find((item) => item.idempotencyKey === idempotencyKey);
  if (!entry) throw new Error(`副作用记录未写入：${idempotencyKey}`);
  return entry;
}

function effectKeyFor(lease: WorkerTaskLease): string {
  return `worker-execution:${requiredText(lease.runId, 'run id')}:${requiredText(lease.task.id, 'task id')}:attempt-${lease.attempt}`;
}

function inputHashFor(lease: WorkerTaskLease): string {
  return [
    lease.runId,
    lease.task.id,
    lease.task.version,
    lease.attempt,
    lease.assignment.baseRevision,
  ].join(':');
}

/**
 * Persist the Worker execution lifecycle in the project side-effect journal.
 * The journal is outside the worktree and is the source used during restart recovery.
 */
export function createWorkerSideEffectRecorder(
  repository: SideEffectJournalRepository,
  now: WorkerSideEffectClock = () => new Date().toISOString(),
): WorkerSideEffectRecorderWithRecovery {
  return {
    async start(lease): Promise<SideEffectRecord> {
      const idempotencyKey = effectKeyFor(lease);
      const parsed = await repository.read();
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const existing = parsed.journal.entries.find((item) => item.idempotencyKey === idempotencyKey);
      if (existing?.status === 'receipt') {
        throw new Error(`Worker side effect 已有 receipt，拒绝重复执行：${idempotencyKey}`);
      }
      if (existing?.status === 'unknown' || existing?.status === 'started') {
        throw new Error(`Worker side effect 需要先恢复核对：${idempotencyKey}`);
      }

      const planned = createSideEffect({
        idempotencyKey,
        kind: 'worker-execution',
        target: requiredText(lease.assignment.worktreeId, 'worktree id'),
        inputHash: inputHashFor(lease),
        runId: lease.runId,
        taskId: lease.task.id,
        taskExecutionId: lease.taskExecutionId,
        attemptId: lease.attemptId,
      });
      const afterPlanned = await repository.record(planned);
      const started = startSideEffect(entryFor(afterPlanned, idempotencyKey));
      return entryFor(await repository.record(started), idempotencyKey);
    },

    async complete(record, _result: WorkerExecutionResult): Promise<SideEffectRecord> {
      const receipt = {
        receiptId: `${requiredText(record.idempotencyKey, 'idempotencyKey')}:receipt`,
        observedAt: now(),
      };
      const completed = completeSideEffect(record, receipt);
      return entryFor(await repository.record(completed), record.idempotencyKey);
    },

    async markUnknown(record, reason): Promise<SideEffectRecord> {
      if (record.status !== 'started') return record;
      const unknown = recoverInterruptedSideEffect(record, requiredText(reason, 'unknown reason'));
      return entryFor(await repository.record(unknown), record.idempotencyKey);
    },

    async recoverInterruptedRun(runId): Promise<SideEffectJournal> {
      const normalizedRunId = requiredText(runId, 'run id');
      const parsed = await repository.read();
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      for (const entry of parsed.journal.entries) {
        if (entry.runId === normalizedRunId && entry.status === 'started') {
          await repository.record(recoverInterruptedSideEffect(entry, 'worker-run-restarted'));
        }
      }
      return (await repository.read()).journal;
    },
  };
}

export function buildWorkerRunRecoveryPlan(
  runId: string,
  journal: SideEffectJournal,
): WorkerRunRecoveryPlan {
  const normalizedRunId = requiredText(runId, 'run id');
  const effects = journal.entries
    .filter((entry) => entry.runId === normalizedRunId)
    .map((entry) => ({ ...entry }));
  return {
    runId: normalizedRunId,
    effects,
    effectKeys: effects.map((entry) => entry.idempotencyKey),
    requiresUser: effects.some((entry) => entry.status === 'started' || entry.status === 'unknown'),
    allowedDecisions: ['inspect', 'retry', 'skip'],
  };
}

/** Apply only the decision metadata; retry execution is a separate, new attempt. */
export function decideWorkerRunRecovery(
  plan: WorkerRunRecoveryPlan,
  decision: WorkerRunRecoveryDecision,
  reason: string,
): AppliedWorkerRunRecoveryDecision {
  if (!plan.allowedDecisions.includes(decision)) throw new Error(`不允许的恢复决策：${decision}`);
  const normalizedReason = requiredText(reason, '恢复理由');
  if (!plan.requiresUser) throw new Error(`Run 没有待核对的副作用：${plan.runId}`);
  return {
    runId: plan.runId,
    decision,
    reason: normalizedReason,
    effectKeys: [...plan.effectKeys],
    requiresNewAttempt: decision === 'retry',
  };
}

export function applyWorkerRunRecoveryDecision(input: {
  plan: WorkerRunRecoveryPlan;
  state: WorkerRunQueueState;
  taskGraph: ProjectTaskGraph;
  decision: WorkerRunRecoveryDecision;
  reason: string;
  now: string;
}): WorkerRunQueueState {
  const applied = decideWorkerRunRecovery(input.plan, input.decision, input.reason);
  if (applied.decision === 'inspect') return { ...input.state, tasks: { ...input.state.tasks } };

  const effectTaskIds = new Set(
    input.plan.effects.map((effect) => effect.taskId).filter((taskId): taskId is string => !!taskId),
  );
  if (effectTaskIds.size === 0) {
    for (const [taskId, task] of Object.entries(input.state.tasks)) {
      if (task.status === 'running') effectTaskIds.add(taskId);
    }
  }
  if (effectTaskIds.size === 0) throw new Error(`恢复计划没有绑定可处理的任务：${input.state.runId}`);

  const tasks = Object.fromEntries(
    Object.entries(input.state.tasks).map(([taskId, task]) => {
      if (!effectTaskIds.has(taskId)) return [taskId, { ...task, evidenceIds: [...task.evidenceIds] }];
      if (applied.decision === 'retry') {
        return [taskId, {
          ...task,
          status: 'queued' as const,
          worktreeId: undefined,
          worktreePath: undefined,
          branch: undefined,
          baseRevision: undefined,
          evidenceIds: [],
          acceptanceId: undefined,
          cleanupStatus: undefined,
          cleanupReceiptId: undefined,
          error: undefined,
          updatedAt: input.now,
        }];
      }
      return [taskId, {
        ...task,
        status: 'failed' as const,
        error: `恢复决策 skip：${requiredText(input.reason, '恢复理由')}`,
        updatedAt: input.now,
      }];
    }),
  ) as WorkerRunQueueState['tasks'];
  const next: WorkerRunQueueState = {
    ...input.state,
    status: applied.decision === 'retry' ? 'queued' : 'partial',
    updatedAt: input.now,
    tasks,
  };
  const queue = restoreWorkerRunQueue({ taskGraph: input.taskGraph, state: next });
  if (applied.decision === 'skip') queue.runnableTaskIds();
  return queue.snapshot();
}
