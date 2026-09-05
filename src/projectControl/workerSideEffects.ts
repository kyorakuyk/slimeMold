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
  WorkerSideEffectClaim,
  WorkerSideEffectRecorder,
  WorkerTaskLease,
} from '../domain/workerQueue';
import { restoreWorkerRunQueue } from '../domain/workerQueue';
import { assertTaskExecutionLineage, createTaskExecutionId } from '../domain/execution';
import type { ProjectTaskGraph } from './types';

export type WorkerRunRecoveryDecision = 'inspect' | 'retry' | 'skip';

export interface WorkerRunRecoveryPlan {
  runId: string;
  effects: SideEffectRecord[];
  recoverableEffects?: SideEffectRecord[];
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
  recoverInterruptedRun(runId: string, options?: { signal?: AbortSignal }): Promise<SideEffectJournal>;
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
  const lineage = assertTaskExecutionLineage({
    runId: lease.runId,
    taskId: lease.task.id,
    taskExecutionId: lease.taskExecutionId,
    attemptId: lease.attemptId,
    attempt: lease.attempt,
  });
  return `worker-execution:${lineage.taskExecutionId}:attempt-${lineage.attempt}`;
}

function legacyEffectKeyFor(lease: WorkerTaskLease): string {
  return `worker-execution:${requiredText(lease.runId, 'run id')}:${requiredText(lease.task.id, 'task id')}:attempt-${lease.attempt}`;
}

function effectBelongsToCurrentAttempt(
  effect: SideEffectRecord,
  state: WorkerRunQueueState,
  taskId: string,
): boolean {
  const task = state.tasks[taskId];
  if (!task || (task.status !== 'running' && task.status !== 'failed') || effect.runId !== state.runId) return false;
  if (effect.taskId !== taskId || !effect.taskExecutionId || !effect.attemptId || !task.currentAttemptId) {
    return false;
  }
  const taskExecutionId = task.taskExecutionId ?? createTaskExecutionId(state.runId, taskId);
  try {
    assertTaskExecutionLineage({
      runId: state.runId,
      taskId,
      taskExecutionId: effect.taskExecutionId,
      attemptId: effect.attemptId,
      attempt: task.attempt,
    });
    assertTaskExecutionLineage({
      runId: state.runId,
      taskId,
      taskExecutionId,
      attemptId: task.currentAttemptId,
      attempt: task.attempt,
    });
  } catch {
    return false;
  }
  return effect.taskExecutionId === taskExecutionId && effect.attemptId === task.currentAttemptId;
}

function inputHashFor(lease: WorkerTaskLease): string {
  return JSON.stringify([
    lease.runId,
    lease.task.id,
    lease.task.version,
    lease.attempt,
    lease.assignment.baseRevision,
    lease.assignment.path,
    lease.assignment.branch,
  ]);
}

function legacyInputHashFor(lease: WorkerTaskLease): string {
  return [
    lease.runId,
    lease.task.id,
    lease.task.version,
    lease.attempt,
    lease.assignment.baseRevision,
  ].join(':');
}

function assertExistingEffectMatchesLease(
  existing: SideEffectRecord,
  lease: WorkerTaskLease,
  key: string,
): void {
  const expectedKey = effectKeyFor(lease);
  const legacyKey = legacyEffectKeyFor(lease);
  if (key !== expectedKey && key !== legacyKey) {
    throw new Error(`Worker side effect key 与 lease 不一致：${key}`);
  }
  if (existing.runId !== lease.runId || existing.taskId !== lease.task.id) {
    throw new Error(`Worker side effect 绑定的 run/task 不一致：${key}`);
  }
  if (existing.target !== lease.assignment.worktreeId) {
    throw new Error(`Worker side effect 绑定的 worktree 不一致：${key}`);
  }
  const expectedInputHash = key === legacyKey ? legacyInputHashFor(lease) : inputHashFor(lease);
  if (existing.inputHash !== expectedInputHash) {
    throw new Error(`Worker side effect inputHash 不一致：${key}`);
  }
  if (!existing.taskExecutionId || !existing.attemptId) {
    throw new Error(`旧 Worker side effect 缺少 lineage，拒绝安全恢复：${key}`);
  }
  assertTaskExecutionLineage({
    runId: lease.runId,
    taskId: lease.task.id,
    taskExecutionId: existing.taskExecutionId,
    attemptId: existing.attemptId,
    attempt: lease.attempt,
  });
}

/**
 * Persist the Worker execution lifecycle in the project side-effect journal.
 * The journal is outside the worktree and is the source used during restart recovery.
 */
function assertWorkerExecutionReceipt(record: SideEffectRecord, lease: WorkerTaskLease): void {
  const key = effectKeyFor(lease);
  if (
    record.status !== 'receipt'
    || record.idempotencyKey !== key
    || record.kind !== 'worker-execution'
    || record.target !== requiredText(lease.assignment.worktreeId, 'worktree id')
    || record.inputHash !== inputHashFor(lease)
    || record.runId !== lease.runId
    || record.taskId !== lease.task.id
    || record.taskExecutionId !== lease.taskExecutionId
    || record.attemptId !== lease.attemptId
    || record.recovery !== 'skip'
    || record.receipt?.receiptId !== `${key}:receipt`
    || !record.receipt.outcome
  ) {
    throw new Error(`已有 Worker receipt 未通过 canonical 校验：${record.idempotencyKey}`);
  }
  if (record.receipt.outcome === 'succeeded' && record.receipt.evidenceIds === undefined) {
    throw new Error(`成功 Worker receipt 缺少 Evidence provenance：${key}`);
  }
}

export function createWorkerSideEffectRecorder(
  repository: SideEffectJournalRepository,
  now: WorkerSideEffectClock = () => new Date().toISOString(),
): WorkerSideEffectRecorderWithRecovery {
  return {
    async claim(lease): Promise<WorkerSideEffectClaim> {
      const idempotencyKey = effectKeyFor(lease);
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
      const legacyPlanned = createSideEffect({
        idempotencyKey: legacyEffectKeyFor(lease),
        kind: 'worker-execution',
        target: requiredText(lease.assignment.worktreeId, 'worktree id'),
        inputHash: legacyInputHashFor(lease),
        runId: lease.runId,
        taskId: lease.task.id,
      });
      const claimed = await repository.claim(startSideEffect(planned), [legacyPlanned]);
      if (!claimed.claimed && claimed.record.status === 'receipt') {
        assertWorkerExecutionReceipt(claimed.record, lease);
      }
      return { record: claimed.record, claimed: claimed.claimed };
    },

    async start(lease): Promise<SideEffectRecord> {
      const idempotencyKey = effectKeyFor(lease);
      const claimed = await this.claim!(lease);
      if (claimed.claimed) return claimed.record;
      assertExistingEffectMatchesLease(claimed.record, lease, claimed.record.idempotencyKey);
      if (claimed.record.status === 'receipt') {
        throw new Error(`Worker side effect 已有 receipt，拒绝重复执行：${idempotencyKey}`);
      }
      if (claimed.record.status === 'unknown' || claimed.record.status === 'started') {
        throw new Error(`Worker side effect 需要先恢复核对：${idempotencyKey}`);
      }
      throw new Error(`Worker side effect 当前不可启动：${idempotencyKey}`);
    },

    async complete(record, result: WorkerExecutionResult): Promise<SideEffectRecord> {
      const parsed = await repository.read();
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const current = entryFor(parsed.journal, record.idempotencyKey);
      const sameIdentity = current.kind === record.kind
        && current.target === record.target
        && current.inputHash === record.inputHash
        && current.runId === record.runId
        && current.taskId === record.taskId
        && current.taskExecutionId === record.taskExecutionId
        && current.attemptId === record.attemptId;
      if (!sameIdentity) throw new Error(`迟到 Worker completion 的 lineage 不一致：${record.idempotencyKey}`);
      if (current.status !== 'started') return current;
      const receipt = {
        receiptId: `${requiredText(current.idempotencyKey, 'idempotencyKey')}:receipt`,
        observedAt: now(),
        outcome: result.status,
        ...(result.evidenceIds ? { evidenceIds: [...result.evidenceIds] } : {}),
        ...(result.acceptanceId ? { acceptanceId: result.acceptanceId } : {}),
        ...(result.status === 'failed' && result.error ? { error: result.error } : {}),
      };
      const completed = completeSideEffect(current, receipt);
      return entryFor(await repository.record(completed), current.idempotencyKey);
    },

    async markUnknown(record, reason): Promise<SideEffectRecord> {
      if (record.status !== 'started') return record;
      const unknown = recoverInterruptedSideEffect(record, requiredText(reason, 'unknown reason'));
      return entryFor(await repository.record(unknown), record.idempotencyKey);
    },

    async recoverInterruptedRun(runId, options = {}): Promise<SideEffectJournal> {
      const normalizedRunId = requiredText(runId, 'run id');
      if (options.signal?.aborted) throw new Error('Worker recovery 已取消');
      const parsed = await repository.read();
      if (options.signal?.aborted) throw new Error('Worker recovery 已取消');
      if (parsed.status === 'needs-repair') {
        throw new SideEffectJournalError(
          'needs-repair',
          `副作用账本需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      for (const entry of parsed.journal.entries) {
        if (options.signal?.aborted) throw new Error('Worker recovery 已取消');
        if (entry.runId === normalizedRunId && entry.status === 'started') {
          await repository.record(recoverInterruptedSideEffect(entry, 'worker-run-restarted'));
          if (options.signal?.aborted) throw new Error('Worker recovery 已取消');
        }
      }
      if (options.signal?.aborted) throw new Error('Worker recovery 已取消');
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
  return normalizeWorkerRunRecoveryPlan({
    runId: normalizedRunId,
    effects,
    recoverableEffects: effects.filter((entry) => entry.status === 'started' || entry.status === 'unknown'),
    effectKeys: [],
    requiresUser: false,
    allowedDecisions: ['inspect', 'retry', 'skip'],
  });
}

function normalizeWorkerRunRecoveryPlan(plan: WorkerRunRecoveryPlan): WorkerRunRecoveryPlan {
  const runId = requiredText(plan.runId, 'run id');
  const effects = Array.isArray(plan.effects) ? plan.effects.map((effect) => ({ ...effect })) : [];
  const suppliedRecoverable = plan.recoverableEffects;
  const candidates = effects
    .filter((effect) => effect.status === 'started' || effect.status === 'unknown');
  if (suppliedRecoverable) {
    if (
      suppliedRecoverable.length !== candidates.length
      || candidates.some((effect) => !suppliedRecoverable.some((item) => JSON.stringify(item) === JSON.stringify(effect)))
    ) {
      throw new Error(`recoverableEffects 必须与 plan.effects 中的全部待恢复记录一致：${runId}`);
    }
  }
  for (const effect of candidates) {
    if (
      effect.runId !== runId
      || !effect.taskId
      || !effect.taskExecutionId
      || !effect.attemptId
    ) {
      throw new Error(`恢复 effect 缺少完整 current lineage：${effect.idempotencyKey}`);
    }
    try {
      assertTaskExecutionLineage({
        runId,
        taskId: effect.taskId,
        taskExecutionId: effect.taskExecutionId,
        attemptId: effect.attemptId,
      });
    } catch (error) {
      throw new Error(`恢复 effect lineage 无法验证：${effect.idempotencyKey}（${error instanceof Error ? error.message : String(error)}）`);
    }

  }
  const allowedDecisions = (['inspect', 'retry', 'skip'] as const)
    .filter((decision) => plan.allowedDecisions.includes(decision));
  if (allowedDecisions.length === 0) throw new Error(`恢复计划没有合法决策：${runId}`);
  return {
    runId,
    effects,
    recoverableEffects: candidates,
    effectKeys: candidates.map((effect) => effect.idempotencyKey),
    requiresUser: candidates.length > 0,
    allowedDecisions,
  };
}

/** Apply only the decision metadata; retry execution is a separate, new attempt. */
export function decideWorkerRunRecovery(
  plan: WorkerRunRecoveryPlan,
  decision: WorkerRunRecoveryDecision,
  reason: string,
): AppliedWorkerRunRecoveryDecision {
  const normalizedPlan = normalizeWorkerRunRecoveryPlan(plan);
  if (!normalizedPlan.allowedDecisions.includes(decision)) throw new Error(`不允许的恢复决策：${decision}`);
  const normalizedReason = requiredText(reason, '恢复理由');
  if (!normalizedPlan.requiresUser) throw new Error(`Run 没有待核对的副作用：${normalizedPlan.runId}`);
  return {
    runId: normalizedPlan.runId,
    decision,
    reason: normalizedReason,
    effectKeys: [...normalizedPlan.effectKeys],
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
  const plan = normalizeWorkerRunRecoveryPlan(input.plan);
  if (plan.runId !== input.state.runId) {
    throw new Error(`恢复计划 runId 与 Worker Run 不一致：${plan.runId}`);
  }
  const applied = decideWorkerRunRecovery(plan, input.decision, input.reason);
  if (applied.decision === 'inspect') return { ...input.state, tasks: { ...input.state.tasks } };

  const recoverableEffects = plan.recoverableEffects ?? [];
  const scopedRecoverableEffects = recoverableEffects.filter((effect) => (
    effect.taskId !== undefined
    && effectBelongsToCurrentAttempt(effect, input.state, effect.taskId)
  ));
  const effectTaskIds = new Set(
    scopedRecoverableEffects.map((effect) => effect.taskId).filter((taskId): taskId is string => !!taskId),
  );
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
          currentAttemptId: undefined,
          pendingAttempt: task.attempt + 1,
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
