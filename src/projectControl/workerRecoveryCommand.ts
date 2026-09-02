import type { DomainEvent } from '../domain/contracts';
import type { SideEffectJournal } from '../domain/sideEffects';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import {
  applyWorkerRunRecoveryDecision,
  buildWorkerRunRecoveryPlan,
  decideWorkerRunRecovery,
  type WorkerRunRecoveryDecision,
  type WorkerRunRecoveryPlan,
} from './workerSideEffects';

export interface RecoverWorkerRunCommandInput {
  projectId: string;
  state: WorkerRunQueueState;
  taskGraph: ProjectTaskGraph;
  journal: SideEffectJournal;
  decision: WorkerRunRecoveryDecision;
  reason: string;
  decisionId: string;
  now: string;
}

export interface RecoverWorkerRunCommandResult {
  state: WorkerRunQueueState;
  plan: WorkerRunRecoveryPlan;
  decision: ReturnType<typeof decideWorkerRunRecovery>;
  events: DomainEvent[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function createEvents(
  input: RecoverWorkerRunCommandInput,
  plan: WorkerRunRecoveryPlan,
  decision: ReturnType<typeof decideWorkerRunRecovery>,
  next: WorkerRunQueueState,
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const aggregateVersions = new Map<string, number>();
  let sequence = 0;
  const source = { objectId: input.taskGraph.id, objectVersion: input.taskGraph.graphVersion };
  const emit = (
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): void => {
    const aggregateKey = `${aggregateType}:${aggregateId}`;
    const aggregateVersion = (aggregateVersions.get(aggregateKey) ?? 0) + 1;
    aggregateVersions.set(aggregateKey, aggregateVersion);
    events.push({
      eventId: `${input.decisionId}:${eventType}:${aggregateId}`,
      streamId: input.projectId,
      sequence: ++sequence,
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventType,
      schemaVersion: 1,
      payload,
      actor: 'user',
      occurredAt: input.now,
      correlationId: input.state.runId,
      source,
      sensitivity: 'normal',
    });
  };

  emit('WorkerRunRecoveryDecided', 'Run', input.state.runId, {
    runId: input.state.runId,
    decision: decision.decision,
    reason: decision.reason,
    effectKeys: plan.effectKeys,
    requiresNewAttempt: decision.requiresNewAttempt,
  });

  if (next.status !== input.state.status && next.status === 'queued') {
    emit('RunQueued', 'Run', next.runId, {
      runId: next.runId,
      reason: decision.reason,
      recoveryDecisionId: input.decisionId,
    });
  }
  if (next.status !== input.state.status && next.status === 'partial') {
    emit('RunPartial', 'Run', next.runId, {
      runId: next.runId,
      recoveryDecisionId: input.decisionId,
    });
  }

  for (const task of input.taskGraph.tasks) {
    const before = input.state.tasks[task.id];
    const after = next.tasks[task.id];
    if (!before || !after || before.status === after.status) continue;
    if (after.status === 'queued') {
      emit('TaskQueued', 'Task', task.id, {
        runId: next.runId,
        recoveryDecisionId: input.decisionId,
      });
    } else if (after.status === 'failed') {
      emit('TaskFailed', 'Task', task.id, {
        runId: next.runId,
        error: after.error ?? '恢复决策导致任务跳过',
        attempt: after.attempt,
      });
    } else if (after.status === 'blocked') {
      emit('TaskBlocked', 'Task', task.id, {
        runId: next.runId,
        blockedBy: task.dependsOn,
        reason: after.error ?? '依赖任务被跳过',
      });
    }
  }
  return events;
}

/** Event-producing recovery command; applying retry never starts a Worker itself. */
export function recoverWorkerRunCommand(
  input: RecoverWorkerRunCommandInput,
): RecoverWorkerRunCommandResult {
  const projectId = requiredText(input.projectId, '项目 id');
  if (input.state.projectId !== projectId) throw new Error(`Worker Run 不属于当前项目：${input.state.projectId}`);
  if (input.taskGraph.id !== input.state.taskGraphId) throw new Error('恢复任务图与 Run 不一致');
  if (input.taskGraph.graphVersion !== input.state.taskGraphVersion) throw new Error('恢复任务图版本已漂移');
  const decisionId = requiredText(input.decisionId, '恢复决策 id');
  const reason = requiredText(input.reason, '恢复理由');
  const plan = buildWorkerRunRecoveryPlan(input.state.runId, input.journal);
  const decision = decideWorkerRunRecovery(plan, input.decision, reason);
  const state = applyWorkerRunRecoveryDecision({
    plan,
    state: input.state,
    taskGraph: input.taskGraph,
    decision: input.decision,
    reason,
    now: requiredText(input.now, '时间'),
  });
  const events = createEvents({ ...input, projectId, decisionId, reason }, plan, decision, state);
  return { state, plan, decision, events };
}
