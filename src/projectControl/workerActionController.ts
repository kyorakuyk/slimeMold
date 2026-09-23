import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import type { Orchestration } from '../types/orchestration';
import { replayDomainEvents, type DomainEvent, type SideEffectRecord } from '../domain/contracts';
import { restoreWorkerRunQueue, type WorkerRunQueueState } from '../domain/workerQueue';
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

function sortedIds(values: readonly string[]): string[] {
  return [...values].sort();
}

function assertCandidateMatchesTrustedTaskGraph(
  candidate: WorkerRecoveryDecisionCandidate,
  taskGraph: ProjectTaskGraph,
  requestKey: string,
): void {
  const graphTaskIds = sortedIds(taskGraph.tasks.map((task) => task.id));
  const candidateTaskIds = sortedIds(candidate.taskGraphTaskIds);
  if (JSON.stringify(graphTaskIds) !== JSON.stringify(candidateTaskIds)) {
    throw new WorkerRecoveryDecisionCasError(
      'needs-repair',
      `recovery candidate task set 与当前可信 TaskGraph 不一致：${requestKey}`,
    );
  }
  for (const task of taskGraph.tasks) {
    const candidateTask = candidate.state.tasks[task.id];
    if (!candidateTask
      || (candidateTask.taskDefinitionVersion !== undefined
        && candidateTask.taskDefinitionVersion !== task.version)) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery candidate task definition 与当前可信 TaskGraph 不一致：${requestKey}`,
      );
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
  runQueuedWorker: (runId: string, workerRuntime?: WorkerRuntime) => Promise<void>;
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
} {
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;
  const recoverySingleFlight = deps.recoverySingleFlight ?? createWorkerRecoverySingleFlight();

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
      const taskGraphId = capturedRun?.taskGraphId ?? durableRecord?.candidate.state.taskGraphId;
      const taskGraph = taskGraphId
        ? capturedState.taskGraphs.find((item) => item.id === taskGraphId)
        : undefined;
      if (!taskGraph) throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `找不到 durable recovery 对应的 TaskGraph：${runId}`,
      );
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

      const modulesPromise = loadWorkerHostRepositoryModules();
      const bundle = createWorkerHostRepositoryBundleFromModules(
        {
          projectPath,
          listAcceptances: () => session.listAcceptances(),
        },
        await modulesPromise,
      );
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
          && candidate.events.every((expected) => eventStream.events.some((actual) => samePersistedEvent(expected, actual)));
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

      const dispatchPostCommit = async (record: WorkerRecoveryDecisionRecord): Promise<void> => {
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
          await deps.runQueuedWorker(runId, workerRuntime);
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

    assertCandidateMatchesTrustedTaskGraph(decisionInput.candidate, capturedTaskGraph, requestKey);

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
        replayDomainEvents(persistedEvents.events);
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
    await dispatchPostCommit(postCommitRecord);
    } finally {
      lease.release();
    }
  };

  return { recoverWorkerRun };
}
