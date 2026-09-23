import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import type { Orchestration } from '../types/orchestration';
import { replayDomainEvents, type DomainEvent, type SideEffectRecord } from '../domain/contracts';
import {
  resolveWorkerAcceptanceStageId,
  restoreWorkerRunQueue,
  type WorkerRunQueueState,
} from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { WorkerCleanupProposal } from './workerCleanup';
import type { WorkerRuntime } from './workerRunCoordinator';
import type { ProjectOperation } from './projectLifecycleController';
import { recoverWorkerRunCommand } from './workerRecoveryCommand';
import { installWorkerRunRuntime, rehydrateWorkerRunRegistry } from './workerRunRuntime';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';
import { mergeWorkerSideEffects } from './workerEvidence';
import { assertWorkerRecoveryDecisionPrecondition } from './workerRecoveryDecisionPrecondition';
import { fingerprintWorkerRecoveryFactsV1 } from './workerRecoveryFactsFingerprint';
import {
  WorkerRecoveryDecisionCasError,
  WorkerRecoveryDecisionPersistence,
  type WorkerRecoveryDecisionCandidate,
  type WorkerRecoveryDecisionInput,
  type WorkerRecoveryDecisionRecord,
} from './workerRecoveryDecisionPersistence';
import {
  createWorkerRecoverySingleFlight,
  type WorkerRecoverySingleFlight,
} from './workerRecoverySingleFlight';
import { createWorkerHostRepositoryBundleFromModules, loadWorkerHostRepositoryModules } from './workerHostRepositoryBundle';

type ProjectSave = (
  projectId: string,
  projectPath: string,
  signal?: AbortSignal,
) => Promise<void>;

type PersistedProjectProjection = {
  workerRuns: WorkerRunQueueState[];
  orchestrations: Orchestration[];
};

function samePersistedEvent(expected: DomainEvent, actual: DomainEvent): boolean {
  const comparable = (event: DomainEvent): unknown => {
    const {
      sequence: _sequence,
      aggregateVersion: _aggregateVersion,
      ...withoutPosition
    } = event;
    return withoutPosition;
  };
  return JSON.stringify(comparable(expected)) === JSON.stringify(comparable(actual));
}

export function findTrustedRunCreatedEvent(
  events: readonly DomainEvent[],
  runId: string,
  expectedProjectId?: string,
): DomainEvent | undefined {
  const runEvents = events.filter((event) => event.aggregateType === 'Run' && event.aggregateId === runId);
  const candidates = runEvents.filter((event) => {
    if (event.eventType !== 'RunCreated'
      || event.schemaVersion !== 1
      || (expectedProjectId !== undefined && event.streamId !== expectedProjectId)
      || event.aggregateVersion !== 1
      || (event.actor !== 'runtime' && event.actor !== 'system')
      || event.correlationId !== runId
      || !event.source
      || !Number.isSafeInteger(event.source.objectVersion)
      || event.source.objectVersion < 1) return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.runId === runId
      && typeof payload.taskGraphId === 'string'
      && !!payload.taskGraphId.trim()
      && Number.isSafeInteger(payload.taskGraphVersion)
      && (payload.taskGraphVersion as number) >= 1
      && Array.isArray(payload.taskIds)
      && payload.taskIds.length > 0
      && payload.taskIds.every((taskId) => typeof taskId === 'string' && !!taskId.trim())
      && new Set(payload.taskIds).size === payload.taskIds.length;
  });
  if (candidates.length !== 1 || runEvents[0]?.eventId !== candidates[0].eventId) return undefined;
  return candidates[0];
}

function sortedIds(values: readonly string[]): string[] {
  return [...values].sort();
}

function assertCandidateMatchesTrustedTaskGraph(
  candidate: WorkerRecoveryDecisionCandidate,
  taskGraph: ProjectTaskGraph,
  requestKey: string,
  capturedRun?: WorkerRunQueueState,
  decision?: 'retry' | 'skip',
): void {
  const graphTaskIds = sortedIds(taskGraph.tasks.map((task) => task.id));
  const candidateTaskIds = sortedIds(candidate.taskGraphTaskIds);
  if (candidate.state.taskGraphId !== taskGraph.id
    || candidate.state.taskGraphVersion !== taskGraph.graphVersion) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate graph identity 与当前可信 TaskGraph 不一致：${requestKey}`,
    );
  }
  if (JSON.stringify(graphTaskIds) !== JSON.stringify(candidateTaskIds)) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate task set 与当前可信 TaskGraph 不一致：${requestKey}`,
    );
  }
  for (const task of taskGraph.tasks) {
    const candidateTask = candidate.state.tasks[task.id];
    if (!candidateTask
      || candidateTask.taskDefinitionVersion !== task.version
      || resolveWorkerAcceptanceStageId(task.id, candidateTask.acceptanceStageId)
        !== resolveWorkerAcceptanceStageId(task.id, task.stageId)) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery candidate task definition 与当前可信 TaskGraph 不一致：${requestKey}`,
      );
    }
  }
  for (const event of candidate.events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.eventType === 'TaskBlocked') {
      const task = taskGraph.tasks.find((item) => item.id === payload.taskId);
      const blockedBy = payload.blockedBy;
      if (!task || !Array.isArray(blockedBy)
        || blockedBy.some((dependency) => typeof dependency !== 'string' || !task.dependsOn.includes(dependency))) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate blockedBy 超出可信 TaskGraph 依赖：${requestKey}`,
        );
      }
    }
    if (event.eventType === 'TaskQueued') {
      const task = taskGraph.tasks.find((item) => item.id === payload.taskId);
      const candidateTask = typeof payload.taskId === 'string' ? candidate.state.tasks[payload.taskId] : undefined;
      if (!task || !candidateTask
        || payload.taskExecutionId !== candidateTask.taskExecutionId
        || payload.nextAttempt !== candidateTask.pendingAttempt) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate TaskQueued lineage 与可信 TaskGraph/候选状态不一致：${requestKey}`,
        );
      }
    }
  }
  if (capturedRun && decision) {
    for (const task of taskGraph.tasks) {
      const before = capturedRun.tasks[task.id];
      const after = candidate.state.tasks[task.id];
      if (!before || !after) continue;
      const isResetForRetry = decision === 'retry'
        && (before.status === 'failed' || before.status === 'running')
        && after.status === 'queued'
        && after.pendingAttempt === before.attempt + 1;
      const authorityFields = [
        'worktreeId',
        'worktreePath',
        'branch',
        'baseRevision',
        'targetIdentity',
        'worktreeStatus',
        'branchRevision',
        'cleanupStateSignature',
        'cleanupStatus',
        'cleanupReceiptId',
      ] as const;
      const stableProvenanceFields = [
        'taskDefinitionVersion',
        'contextPackId',
        'contextPackVersion',
      ] as const;
      if (
        resolveWorkerAcceptanceStageId(task.id, after.acceptanceStageId)
          !== resolveWorkerAcceptanceStageId(task.id, before.acceptanceStageId)
        || stableProvenanceFields.some((field) => after[field] !== before[field])
      ) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate 改变了可信 task provenance/context pack：${requestKey}`,
        );
      }
      if (isResetForRetry) {
        if (authorityFields.some((field) => after[field] !== undefined)) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `retry recovery candidate 保留了旧 attempt authority：${requestKey}`,
          );
        }
      } else if (authorityFields.some((field) => after[field] !== before[field])) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate 未保持未受影响的 worktree/cleanup authority：${requestKey}`,
        );
      }
    }
  }
  try {
    restoreWorkerRunQueue({ taskGraph, state: candidate.state });
  } catch (cause) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate 未通过 Worker queue restore 校验：${requestKey} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

function candidateEventsArePersistedInOrder(
  candidateEvents: readonly DomainEvent[],
  persistedEvents: readonly DomainEvent[],
): boolean {
  let cursor = -1;
  const aggregateOffsets = new Map<string, number>();
  const previousCandidateVersions = new Map<string, number>();
  const previousPersistedVersions = new Map<string, number>();
  for (const candidateEvent of candidateEvents) {
    if (candidateEvent.aggregateVersion < 1) return false;
    const aggregateKey = `${candidateEvent.aggregateType}:${candidateEvent.aggregateId}`;
    const previousCandidateVersion = previousCandidateVersions.get(aggregateKey);
    if (previousCandidateVersion !== undefined
      && candidateEvent.aggregateVersion !== previousCandidateVersion + 1) return false;
    previousCandidateVersions.set(aggregateKey, candidateEvent.aggregateVersion);
    let found = -1;
    for (let index = cursor + 1; index < persistedEvents.length; index += 1) {
      if (samePersistedEvent(candidateEvent, persistedEvents[index])) {
        found = index;
        break;
      }
    }
    if (found < 0) return false;
    const persistedEvent = persistedEvents[found];
    if (persistedEvents.filter((event) => event.eventId === persistedEvent.eventId).length !== 1) return false;
    const previousPersistedVersion = previousPersistedVersions.get(aggregateKey);
    if (previousPersistedVersion !== undefined
      && persistedEvent.aggregateVersion !== previousPersistedVersion + 1) return false;
    previousPersistedVersions.set(aggregateKey, persistedEvent.aggregateVersion);
    const offset = persistedEvent.aggregateVersion - candidateEvent.aggregateVersion;
    const previousOffset = aggregateOffsets.get(aggregateKey);
    if (previousOffset !== undefined && previousOffset !== offset) return false;
    aggregateOffsets.set(aggregateKey, offset);
    cursor = found;
  }
  return true;
}

function assertCandidateMatchesReplayProjection(
  candidate: WorkerRecoveryDecisionCandidate,
  projection: ReturnType<typeof replayDomainEvents>,
  requestKey: string,
): void {
  const runProjection = projection.runs[candidate.state.runId];
  if (!runProjection || runProjection.status !== candidate.state.status) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate run projection 与 event replay 不一致：${requestKey}`,
    );
  }
  const candidateTaskIds = new Set(Object.keys(candidate.state.tasks));
  const replayTaskIds = new Set(
    Object.values(projection.taskExecutions)
      .filter((task) => task.runId === candidate.state.runId)
      .map((task) => task.taskId),
  );
  if (candidateTaskIds.size !== replayTaskIds.size
    || [...candidateTaskIds].some((taskId) => !replayTaskIds.has(taskId))) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate task projection 与 event replay 不一致：${requestKey}`,
    );
  }
  for (const task of Object.values(candidate.state.tasks)) {
    const taskExecutionId = task.taskExecutionId;
    const replay = taskExecutionId ? projection.taskExecutions[taskExecutionId] : undefined;
    if (!replay
      || replay.taskId !== task.taskId
      || replay.runId !== candidate.state.runId
      || replay.status !== task.status
      || replay.currentAttemptId !== task.currentAttemptId
      || replay.pendingAttempt !== task.pendingAttempt
      || JSON.stringify(replay.evidenceIds ?? []) !== JSON.stringify(task.evidenceIds ?? [])
      || replay.acceptanceId !== task.acceptanceId
      || replay.feedbackId !== task.feedbackId
      || replay.cleanupStatus !== task.cleanupStatus
      || replay.cleanupReceiptId !== task.cleanupReceiptId
      || replay.error !== task.error) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery candidate task execution projection 与 event replay 不一致：${requestKey}`,
      );
    }
    if (task.currentAttemptId) {
      const replayAttempt = projection.attempts[task.currentAttemptId];
      if (!replayAttempt
        || replayAttempt.attempt !== task.attempt
        || replayAttempt.status !== task.status
        || replayAttempt.worktreeId !== task.worktreeId
        || replayAttempt.worktreePath !== task.worktreePath
        || replayAttempt.branch !== task.branch
        || replayAttempt.baseRevision !== task.baseRevision
        || replayAttempt.targetIdentity !== task.targetIdentity
        || JSON.stringify(replayAttempt.evidenceIds ?? []) !== JSON.stringify(task.evidenceIds ?? [])
        || replayAttempt.acceptanceId !== task.acceptanceId
        || replayAttempt.feedbackId !== task.feedbackId
        || replayAttempt.cleanupStatus !== task.cleanupStatus
        || replayAttempt.cleanupReceiptId !== task.cleanupReceiptId
        || replayAttempt.error !== task.error) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate attempt projection 与 event replay 不一致：${requestKey}`,
        );
      }
    }
  }
}

function rebaseCandidateEvents(
  persistedEvents: readonly DomainEvent[],
  candidateEvents: readonly DomainEvent[],
): DomainEvent[] {
  const aggregateOffsets = new Map<string, number>();
  for (const event of persistedEvents) {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    aggregateOffsets.set(key, Math.max(aggregateOffsets.get(key) ?? 0, event.aggregateVersion));
  }
  const candidateBaseVersions = new Map<string, number>();
  return candidateEvents.map((event, index) => {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    const baseVersion = candidateBaseVersions.get(key) ?? event.aggregateVersion - 1;
    candidateBaseVersions.set(key, baseVersion);
    const rebased = {
      ...event,
      sequence: persistedEvents.length + index + 1,
      aggregateVersion: (aggregateOffsets.get(key) ?? 0) + event.aggregateVersion - baseVersion,
    };
    return rebased;
  });
}

export function assertCandidateCanReplay(
  candidate: WorkerRecoveryDecisionCandidate,
  persistedEvents: readonly DomainEvent[],
  requestKey: string,
): void {
  try {
    const rebasedEvents = rebaseCandidateEvents(persistedEvents, candidate.events);
    const replayedProjection = replayDomainEvents([...persistedEvents, ...rebasedEvents]);
    assertCandidateMatchesReplayProjection(candidate, replayedProjection, requestKey);
  } catch (cause) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate event 未通过 pre-write domain reducer replay：${requestKey} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

export interface WorkerActionState {
  projectId: string | null;
  projectPath: string | null;
  workerRuns: WorkerRunQueueState[];
  workerRunSideEffects: SideEffectRecord[];
  workerRunRecoveries: WorkerRunRecovery[];
  workerCleanupProposals: WorkerCleanupProposal[];
  orchestrations: Orchestration[];
  taskGraphs: ProjectTaskGraph[];
  setWorkerRunSideEffects: (effects: SideEffectRecord[]) => void;
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  setOrchestrations: (orchestrations: Orchestration[]) => void;
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
  setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => void;
}

export interface WorkerActionControllerDeps {
  getState: () => WorkerActionState;
  getProjectOperation: (projectId: string | null, projectPath: string | null) => ProjectOperation;
  assertProjectOperation: (operation: ProjectOperation) => void;
  recordProjectEvents: (projectId: string, events: Parameters<typeof recoverWorkerRunCommand>[0]['state'] extends never ? never : ReturnType<typeof recoverWorkerRunCommand>['events']) => void;
  saveProject: ProjectSave;
  readProjectProjection: (projectPath: string) => Promise<PersistedProjectProjection | null>;
  runQueuedWorker: (
    runId: string,
    workerRuntime?: WorkerRuntime,
    expectedProjectId?: string,
    expectedProjectPath?: string,
    expectedRunState?: WorkerRunQueueState,
  ) => Promise<void>;
  isTauri: boolean;
  ensureGuiDevSession?: typeof defaultEnsureGuiDevSession;
  recoverySingleFlight?: WorkerRecoverySingleFlight;
  recoveryDecisionPersistence?: WorkerRecoveryDecisionPersistence;
  createRecoveryDecisionPersistence?: (projectPath: string) => Promise<WorkerRecoveryDecisionPersistence>;
}

export function createWorkerActionController(deps: WorkerActionControllerDeps): {
  recoverWorkerRun: (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
    workerRuntime?: WorkerRuntime,
    requestIdentity?: string,
  ) => Promise<void>;
  retryFailedWorkerRecoveryPostCommit: (
    runId: string,
    requestIdentity: string,
    workerRuntime?: WorkerRuntime,
  ) => Promise<void>;
} {
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;
  const recoverySingleFlight = deps.recoverySingleFlight ?? createWorkerRecoverySingleFlight();

  const dispatchPostCommit = async (input: {
    record: WorkerRecoveryDecisionRecord;
    decisionPersistence: WorkerRecoveryDecisionPersistence;
    projectPath: string;
    workerRuntime?: WorkerRuntime;
    verifyCurrentCandidate?: () => Promise<void>;
  }): Promise<void> => {
    const {
      record,
      decisionPersistence,
      projectPath,
      workerRuntime,
      verifyCurrentCandidate,
    } = input;
    if (record.action !== 'retry' || record.postCommitStatus === 'completed') return;
    if (record.postCommitStatus !== 'pending') {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery post-commit side effect 状态未知，拒绝自动重试：${record.requestIdentity}`,
      );
    }
    const recordInput: WorkerRecoveryDecisionInput = {
      projectId: record.projectId,
      runId: record.runId,
      requestIdentity: record.requestIdentity,
      action: record.action,
      semanticPayloadVersion: record.semanticPayloadVersion,
      decisionId: record.decisionId,
      factsFingerprint: record.factsFingerprint,
      candidate: record.candidate,
      now: record.admittedAt,
    };
    const dispatching = await decisionPersistence.markPostCommit(
      recordInput,
      'dispatching',
      new Date().toISOString(),
    );
    try {
      if (verifyCurrentCandidate) await verifyCurrentCandidate();
      await deps.runQueuedWorker(
        record.runId,
        workerRuntime,
        record.projectId,
        projectPath,
        record.candidate.state,
      );
    } catch (cause) {
      await decisionPersistence.markPostCommit(
        {
          ...recordInput,
          now: dispatching.committedAt ?? recordInput.now,
        },
        'failed',
        new Date().toISOString(),
      );
      throw cause;
    }
    await decisionPersistence.markPostCommit(recordInput, 'completed', new Date().toISOString());
  };

  const recoverWorkerRun = async (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
    workerRuntime?: WorkerRuntime,
    requestIdentity?: string,
  ): Promise<void> => {
    if (!deps.isTauri) throw new Error('Worker recovery 需要桌面端项目环境');
    const initial = deps.getState();
    const projectId = initial.projectId;
    const projectPath = initial.projectPath;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，才能恢复 Worker Run');
    const normalizedReason = reason.trim();
    const requestKey = requestIdentity?.trim() || `run:${runId}:${decision}`;
    const decisionId = `recovery:${requestKey}`;
    const lease = recoverySingleFlight.acquire({ projectId, projectPath, runId });
    if (!lease) throw new Error(`Worker Run 恢复正在处理中：${runId}`);
    try {
      const operation = deps.getProjectOperation(projectId, projectPath);
      deps.assertProjectOperation(operation);
      const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
      if (!session) throw new Error('开发宿主不可用，无法恢复 Worker Acceptance');
      const decisionPersistence = deps.recoveryDecisionPersistence
        ?? (deps.createRecoveryDecisionPersistence
          ? await deps.createRecoveryDecisionPersistence(projectPath)
          : await (async () => {
            const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
            return new WorkerRecoveryDecisionPersistence(
              createTauriEventStoreAdapter(projectPath),
              projectPath,
            );
          })());
      const durableRecord = await decisionPersistence.find(requestKey);
      const capturedState = deps.getState();
      const capturedRun = capturedState.workerRuns.find((item) => item.runId === runId);
      const modules = await loadWorkerHostRepositoryModules();
      const bundle = createWorkerHostRepositoryBundleFromModules(
        {
          projectPath,
          listAcceptances: () => session.listAcceptances(),
        },
        modules,
      );
      const initialEventStream = await bundle.createEventRepository().readStream();
      if (initialEventStream.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery event stream 在 TaskGraph 解析前需要修复：${requestKey}`,
        );
      }
      const trustedRunCreated = findTrustedRunCreatedEvent(initialEventStream.events, runId, projectId);
      const trustedRunCreatedPayload = trustedRunCreated?.payload as Record<string, unknown> | undefined;
      const trustedEventTaskGraphId = typeof trustedRunCreatedPayload?.taskGraphId === 'string'
        ? trustedRunCreatedPayload.taskGraphId
        : undefined;
      const trustedEventTaskGraphVersion = typeof trustedRunCreatedPayload?.taskGraphVersion === 'number'
        ? trustedRunCreatedPayload.taskGraphVersion
        : undefined;
      const taskGraphId = capturedRun?.taskGraphId ?? trustedEventTaskGraphId;
      const taskGraph = taskGraphId
        ? capturedState.taskGraphs.find((item) => item.id === taskGraphId)
        : undefined;
      if (!taskGraph) throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `找不到 durable recovery 对应的 TaskGraph：${runId}`,
      );
      if (taskGraph.approval !== 'approved') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery 对应的 TaskGraph 未批准：${runId}`,
        );
      }
      if (capturedRun && !trustedRunCreated) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `WorkerRun projection 缺少匹配的 RunCreated provenance：${runId}`,
        );
      }
      if (capturedRun
        && (capturedRun.taskGraphId !== taskGraph.id
          || capturedRun.taskGraphVersion !== taskGraph.graphVersion)) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `WorkerRun projection 与当前可信 TaskGraph 不一致：${runId}`,
        );
      }
      if (trustedRunCreated
        && (trustedEventTaskGraphId !== taskGraph.id
          || trustedEventTaskGraphVersion !== taskGraph.graphVersion)) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `RunCreated provenance 与当前可信 TaskGraph 不一致：${runId}`,
        );
      }
      if (trustedRunCreated) {
        const trustedEventTaskIds = sortedIds(
          ((trustedRunCreated.payload as Record<string, unknown>).taskIds as string[]),
        );
        if (JSON.stringify(trustedEventTaskIds) !== JSON.stringify(sortedIds(taskGraph.tasks.map((task) => task.id)))) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `RunCreated taskIds provenance 与当前可信 TaskGraph 不一致：${runId}`,
          );
        }
      }
      if (!capturedRun && (!trustedRunCreated
        || trustedEventTaskGraphId !== taskGraph.id
        || trustedEventTaskGraphVersion !== taskGraph.graphVersion)) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `缺失 WorkerRun projection 时没有可信 RunCreated TaskGraph provenance：${runId}`,
        );
      }
      const capturedTaskGraph = taskGraph;
      if (durableRecord) {
        if (durableRecord.projectId !== projectId
          || durableRecord.runId !== runId
          || durableRecord.action !== decision
          || durableRecord.decisionId !== decisionId) {
          throw new WorkerRecoveryDecisionCasError(
            'conflict',
            `recovery requestIdentity 已绑定其它项目、Run 或 action：${requestKey}`,
          );
        }
        if (durableRecord.candidate.state.taskGraphId !== taskGraph.id
          || durableRecord.candidate.state.taskGraphVersion !== taskGraph.graphVersion) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery durable candidate 与当前 TaskGraph 不一致：${requestKey}`,
          );
        }
      } else if (!capturedRun) {
        throw new Error(`找不到可恢复的 Worker Run：${runId}`);
      }

      const recorder = bundle.sideEffects;
      deps.assertProjectOperation(operation);
      const journal = await recorder.recoverInterruptedRun(runId, { signal: operation.controller.signal });
      deps.assertProjectOperation(operation);
      const afterJournal = deps.getState();
      afterJournal.setWorkerRunSideEffects(mergeWorkerSideEffects(afterJournal.workerRunSideEffects, journal.entries));

      const readCurrentFactsFingerprint = async (): Promise<string | undefined> => {
        const latest = deps.getState();
        const latestRun = latest.workerRuns.find((item) => item.runId === runId);
        const latestTaskGraph = latest.taskGraphs.find((item) => item.id === taskGraph.id);
        if (!latestRun || !latestTaskGraph) return undefined;
        const latestSideEffects = latest.workerRunSideEffects.filter((effect) => effect.runId === runId);
        return fingerprintWorkerRecoveryFactsV1({
          projectId,
          run: latestRun,
          taskGraph: latestTaskGraph,
          sideEffects: latestSideEffects.length > 0 ? latestSideEffects : journal.entries,
        });
      };
      const verifyCurrentCandidate = async (record: WorkerRecoveryDecisionRecord): Promise<void> => {
        const latest = deps.getState();
        if (latest.projectId !== record.projectId || latest.projectPath !== projectPath) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit project context 已漂移：${record.requestIdentity}`,
          );
        }
        const latestTaskGraph = latest.taskGraphs.find((graph) => graph.id === record.candidate.state.taskGraphId);
        if (!latestTaskGraph) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit TaskGraph 已丢失：${record.requestIdentity}`,
          );
        }
        const latestRun = latest.workerRuns.find((item) => item.runId === record.runId);
        if (!latestRun) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit WorkerRun 已丢失：${record.requestIdentity}`,
          );
        }
        const decision = record.action === 'retry' || record.action === 'skip' ? record.action : undefined;
        assertCandidateMatchesTrustedTaskGraph(record.candidate, latestTaskGraph, record.requestIdentity, latestRun, decision);
        if (JSON.stringify(latestRun) !== JSON.stringify(record.candidate.state)) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit candidate/state 已漂移：${record.requestIdentity}`,
          );
        }
      };
      const readCandidateProjection = async (candidate: WorkerRecoveryDecisionCandidate): Promise<{
        stateApplied: boolean;
        fullyApplied: boolean;
      }> => {
        const latest = deps.getState();
        const latestRun = latest.workerRuns.find((item) => item.runId === runId);
        const stateApplied = !!latestRun && JSON.stringify(latestRun) === JSON.stringify(candidate.state);
        if (!stateApplied) return { stateApplied: false, fullyApplied: false };

        const persisted = await deps.readProjectProjection(projectPath);
        const persistedRun = persisted?.workerRuns.find((item) => item.runId === runId);
        if (!persisted || !persistedRun || JSON.stringify(persistedRun) !== JSON.stringify(candidate.state)) {
          return { stateApplied: true, fullyApplied: false };
        }
        if (candidate.state.orchestrationId !== undefined
          && !persisted.orchestrations.some((item) => item.id === candidate.state.orchestrationId)) {
          return { stateApplied: true, fullyApplied: false };
        }
        const expectedOrchestrations = projectWorkerRunsOntoOrchestrations(
          persisted.orchestrations,
          persisted.workerRuns,
        );
        const orchestrationApplied = JSON.stringify(persisted.orchestrations) === JSON.stringify(expectedOrchestrations)
          && JSON.stringify(latest.orchestrations) === JSON.stringify(expectedOrchestrations);
        const expectedRecoveries = rehydrateWorkerRunRegistry({
          projectId,
          taskGraphs: latest.taskGraphs,
          runs: latest.workerRuns,
        }).recoveries;
        const runtimeApplied = JSON.stringify(latest.workerRunRecoveries) === JSON.stringify(expectedRecoveries);
        const cleanupApplied = !latest.workerCleanupProposals.some((proposal) => proposal.runId === runId);
        const eventStream = await bundle.createEventRepository().readStream();
        const eventsApplied = eventStream.status === 'ok'
          && candidateEventsArePersistedInOrder(candidate.events, eventStream.events);
        return {
          stateApplied: true,
          fullyApplied: orchestrationApplied && runtimeApplied && cleanupApplied && eventsApplied,
        };
      };
      const isCandidateApplied = async (candidate: WorkerRecoveryDecisionCandidate): Promise<boolean> =>
        (await readCandidateProjection(candidate)).fullyApplied;
      const isCandidateRepairable = async (candidate: WorkerRecoveryDecisionCandidate): Promise<boolean> => {
        const latestRun = deps.getState().workerRuns.find((item) => item.runId === runId);
        return !latestRun || JSON.stringify(latestRun) === JSON.stringify(candidate.state);
      };
      const isProjectionMissing = async (): Promise<boolean> =>
        !deps.getState().workerRuns.some((item) => item.runId === runId);

      let decisionInput: WorkerRecoveryDecisionInput;
      if (durableRecord) {
        decisionInput = {
          projectId: durableRecord.projectId,
          runId: durableRecord.runId,
          requestIdentity: durableRecord.requestIdentity,
          action: durableRecord.action,
          semanticPayloadVersion: durableRecord.semanticPayloadVersion,
          decisionId: durableRecord.decisionId,
          factsFingerprint: durableRecord.factsFingerprint,
          candidate: durableRecord.candidate,
          now: durableRecord.admittedAt,
        };
      } else {
        if (!capturedRun) throw new Error(`找不到可恢复的 Worker Run：${runId}`);
        const now = new Date().toISOString();
        assertWorkerRecoveryDecisionPrecondition({
          projectId,
          projectPath,
          runId,
          capturedRun,
          capturedTaskGraph,
          current: deps.getState(),
        });
        const factsFingerprint = await fingerprintWorkerRecoveryFactsV1({
          projectId,
          run: capturedRun,
          taskGraph: capturedTaskGraph,
          sideEffects: journal.entries,
        });
        const result = recoverWorkerRunCommand({
          projectId,
          state: capturedRun,
          taskGraph: capturedTaskGraph,
          journal,
          decision,
          reason: normalizedReason,
          decisionId,
          now,
        });
      decisionInput = {
        projectId,
        runId,
        requestIdentity: requestKey,
        action: decision,
        semanticPayloadVersion: 1,
        decisionId,
        factsFingerprint,
        candidate: {
          taskGraphTaskIds: taskGraph.tasks.map((task) => task.id),
          state: result.state,
          events: result.events,
        },
        now,
      };
    }

    assertCandidateMatchesTrustedTaskGraph(
      decisionInput.candidate,
      capturedTaskGraph,
      requestKey,
      capturedRun,
      decision,
    );

    let postCommitRecord: WorkerRecoveryDecisionRecord | undefined;
    await decisionPersistence.withDecisionLock(async (decisionLock) => {
      const admission = await decisionPersistence.admit(decisionInput, {
        readCurrentFactsFingerprint,
        isCandidateApplied,
        isCandidateRepairable,
        isProjectionMissing,
      }, decisionLock);
      if (admission.kind === 'replay') {
        postCommitRecord = admission.record;
        return;
      }
      const admittedCandidate = admission.record.candidate;
      const decisionState = deps.getState();
      const currentRun = decisionState.workerRuns.find((item) => item.runId === runId);
      const stateAlreadyMatches = !!currentRun
        && JSON.stringify(currentRun) === JSON.stringify(admittedCandidate.state);
      if (!stateAlreadyMatches && currentRun) {
        if (!capturedRun) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery candidate 的当前 Worker Run 投影已漂移：${requestKey}`,
          );
        }
        assertWorkerRecoveryDecisionPrecondition({
          projectId,
          projectPath,
          runId,
          capturedRun,
          capturedTaskGraph: taskGraph,
          current: decisionState,
        });
      } else if (!stateAlreadyMatches && admission.kind === 'admitted') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate 的当前 Worker Run 投影已丢失：${requestKey}`,
        );
      }
      deps.assertProjectOperation(operation);
      const preWriteEvents = await bundle.createEventRepository().readStream();
      if (preWriteEvents.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery event stream 在 candidate 写入前需要修复：${requestKey}`,
        );
      }
      assertCandidateCanReplay(admittedCandidate, preWriteEvents.events, requestKey);
      deps.recordProjectEvents(projectId, admittedCandidate.events);
      const nextRuns = currentRun
        ? decisionState.workerRuns.map((item) => item.runId === runId ? admittedCandidate.state : item)
        : [...decisionState.workerRuns, admittedCandidate.state];
      decisionState.setWorkerRuns(nextRuns);
      decisionState.setOrchestrations(
        projectWorkerRunsOntoOrchestrations(decisionState.orchestrations, nextRuns),
      );
      decisionState.setWorkerCleanupProposals(
        decisionState.workerCleanupProposals.filter((proposal) => proposal.runId !== runId),
      );
      const runtime = installWorkerRunRuntime({
        projectId,
        taskGraphs: decisionState.taskGraphs,
        runs: nextRuns,
      });
      decisionState.setWorkerRunRecoveries(runtime.recoveries);
      deps.assertProjectOperation(operation);
      await deps.saveProject(projectId, projectPath, operation.controller.signal);
      deps.assertProjectOperation(operation);
      const persistedEvents = await bundle.createEventRepository().readStream();
      if (persistedEvents.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery event stream 在 candidate save 后需要修复：${requestKey}`,
        );
      }
      try {
        const replayedProjection = replayDomainEvents(persistedEvents.events);
        assertCandidateMatchesReplayProjection(admittedCandidate, replayedProjection, requestKey);
      } catch (cause) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate event 未通过 domain reducer replay：${requestKey} (${cause instanceof Error ? cause.message : String(cause)})`,
        );
      }
      if (!(await isCandidateApplied(admittedCandidate))) {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery candidate 在 ProjectFile 保存期间发生漂移：${requestKey}`,
        );
      }
      const commitInput: WorkerRecoveryDecisionInput = admission.kind === 'admitted'
        ? {
          ...decisionInput,
          candidate: admittedCandidate,
          now: new Date().toISOString(),
        }
        : {
          projectId: admission.record.projectId,
          runId: admission.record.runId,
          requestIdentity: admission.record.requestIdentity,
          action: admission.record.action,
          semanticPayloadVersion: admission.record.semanticPayloadVersion,
          decisionId: admission.record.decisionId,
          factsFingerprint: admission.record.factsFingerprint,
          candidate: admittedCandidate,
          now: admission.record.admittedAt,
        };
      postCommitRecord = await decisionPersistence.commit(commitInput, {
        verifyProjection: () => isCandidateApplied(admittedCandidate),
      }, decisionLock);
    });
    if (!postCommitRecord) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery decision 未产生 durable commit：${requestKey}`,
      );
    }
    await dispatchPostCommit({
      record: postCommitRecord,
      decisionPersistence,
      projectPath,
      workerRuntime,
      verifyCurrentCandidate: () => verifyCurrentCandidate(postCommitRecord!),
    });
    } finally {
      lease.release();
    }
  };

  const retryFailedWorkerRecoveryPostCommit = async (
    runId: string,
    requestIdentity: string,
    workerRuntime?: WorkerRuntime,
  ): Promise<void> => {
    if (!deps.isTauri) throw new Error('Worker recovery 需要桌面端项目环境');
    const initial = deps.getState();
    const projectId = initial.projectId;
    const projectPath = initial.projectPath;
    const normalizedRequestIdentity = requestIdentity.trim();
    if (!projectId || !projectPath) throw new Error('项目必须先保存，才能重试 Worker post-commit');
    if (!normalizedRequestIdentity) throw new Error('Worker post-commit request identity 不能为空');
    const operation = deps.getProjectOperation(projectId, projectPath);
    deps.assertProjectOperation(operation);
    const decisionPersistence = deps.recoveryDecisionPersistence
      ?? (deps.createRecoveryDecisionPersistence
        ? await deps.createRecoveryDecisionPersistence(projectPath)
        : await (async () => {
          const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
          return new WorkerRecoveryDecisionPersistence(
            createTauriEventStoreAdapter(projectPath),
            projectPath,
          );
        })());
    const lease = recoverySingleFlight.acquire({ projectId, projectPath, runId });
    if (!lease) throw new Error(`Worker Run post-commit 重试正在处理中：${runId}`);
    try {
      const record = await decisionPersistence.find(normalizedRequestIdentity);
      if (!record
        || record.projectId !== projectId
        || record.runId !== runId
        || record.action !== 'retry'
        || record.status !== 'committed') {
        throw new WorkerRecoveryDecisionCasError(
          'conflict',
          `找不到可重试的 Worker post-commit decision：${normalizedRequestIdentity}`,
        );
      }
      if (record.postCommitStatus !== 'failed') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `Worker post-commit 当前不可手动重试：${record.postCommitStatus}`,
        );
      }
      const input: WorkerRecoveryDecisionInput = {
        projectId: record.projectId,
        runId: record.runId,
        requestIdentity: record.requestIdentity,
        action: record.action,
        semanticPayloadVersion: record.semanticPayloadVersion,
        decisionId: record.decisionId,
        factsFingerprint: record.factsFingerprint,
        candidate: record.candidate,
        now: record.admittedAt,
      };
      const verifyCurrentCandidate = async (): Promise<void> => {
        const current = deps.getState();
        if (current.projectId !== record.projectId || current.projectPath !== projectPath) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit project context 已漂移：${record.requestIdentity}`,
          );
        }
        const currentGraph = current.taskGraphs.find((graph) => graph.id === record.candidate.state.taskGraphId);
        if (!currentGraph) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit TaskGraph 已丢失：${record.requestIdentity}`,
          );
        }
        assertCandidateMatchesTrustedTaskGraph(record.candidate, currentGraph, record.requestIdentity);
        const currentRun = current.workerRuns.find((item) => item.runId === record.runId);
        if (!currentRun || JSON.stringify(currentRun) !== JSON.stringify(record.candidate.state)) {
          throw new WorkerRecoveryDecisionCasError(
            'needs-repair',
            `recovery post-commit candidate/state 已漂移：${record.requestIdentity}`,
          );
        }
      };
      const pending = await decisionPersistence.markPostCommit(
        input,
        'pending',
        new Date().toISOString(),
      );
      deps.assertProjectOperation(operation);
      await dispatchPostCommit({
        record: pending,
        decisionPersistence,
        projectPath,
        workerRuntime,
        verifyCurrentCandidate,
      });
    } finally {
      lease.release();
    }
  };

  return { recoverWorkerRun, retryFailedWorkerRecoveryPostCommit };
}
