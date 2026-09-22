import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import type { Orchestration } from '../types/orchestration';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { WorkerCleanupProposal } from './workerCleanup';
import type { WorkerRuntime } from './workerRunCoordinator';
import type { ProjectOperation } from './projectLifecycleController';
import { recoverWorkerRunCommand } from './workerRecoveryCommand';
import { installWorkerRunRuntime } from './workerRunRuntime';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';
import { mergeWorkerSideEffects } from './workerEvidence';
import { assertWorkerRecoveryDecisionPrecondition } from './workerRecoveryDecisionPrecondition';
import { fingerprintWorkerRecoveryFactsV1 } from './workerRecoveryFactsFingerprint';
import {
  WorkerRecoveryDecisionPersistence,
  type WorkerRecoveryDecisionCandidate,
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
    const current = deps.getState();
    const projectId = current.projectId;
    const projectPath = current.projectPath;
    const run = current.workerRuns.find((item) => item.runId === runId);
    const taskGraph = run
      ? current.taskGraphs.find((item) => item.id === run.taskGraphId)
      : undefined;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，才能恢复 Worker Run');
    if (!run || !taskGraph) throw new Error(`找不到可恢复的 Worker Run：${runId}`);
    const lease = recoverySingleFlight.acquire({ projectId, projectPath, runId });
    if (!lease) throw new Error(`Worker Run 恢复正在处理中：${runId}`);
    try {
      const operation = deps.getProjectOperation(projectId, projectPath);
    deps.assertProjectOperation(operation);

    const modulesPromise = loadWorkerHostRepositoryModules();
    const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
    if (!session) throw new Error('开发宿主不可用，无法恢复 Worker Acceptance');
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
    current.setWorkerRunSideEffects(mergeWorkerSideEffects(current.workerRunSideEffects, journal.entries));
    const decisionState = deps.getState();
    assertWorkerRecoveryDecisionPrecondition({
      projectId,
      projectPath,
      runId,
      capturedRun: run,
      capturedTaskGraph: taskGraph,
      current: decisionState,
    });
    const normalizedReason = reason.trim();
    const requestKey = requestIdentity?.trim() || `run:${runId}:${decision}`;
    const decisionId = `recovery:${requestKey}`;
    const now = new Date().toISOString();
    const factsFingerprint = await fingerprintWorkerRecoveryFactsV1({
      projectId,
      run,
      taskGraph,
      sideEffects: journal.entries,
    });
    const result = recoverWorkerRunCommand({
      projectId,
      state: run,
      taskGraph,
      journal,
      decision,
      reason: normalizedReason,
      decisionId,
      now,
    });
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
    const readCurrentFactsFingerprint = async (): Promise<string> => {
      const latest = deps.getState();
      const latestRun = latest.workerRuns.find((item) => item.runId === runId);
      const latestTaskGraph = latest.taskGraphs.find((item) => item.id === taskGraph.id);
      if (!latestRun || !latestTaskGraph) throw new Error(`Worker recovery facts 在 admission 期间丢失：${runId}`);
      const latestSideEffects = latest.workerRunSideEffects.filter((effect) => effect.runId === runId);
      return fingerprintWorkerRecoveryFactsV1({
        projectId,
        run: latestRun,
        taskGraph: latestTaskGraph,
        sideEffects: latestSideEffects.length > 0 ? latestSideEffects : journal.entries,
      });
    };
    const admission = await decisionPersistence.admit({
      projectId,
      runId,
      requestIdentity: requestKey,
      action: decision,
      semanticPayloadVersion: 1,
      decisionId,
      factsFingerprint,
      candidate: {
        state: result.state,
        events: result.events,
      },
      now,
    }, {
      readCurrentFactsFingerprint,
      isCandidateApplied: async (candidate: WorkerRecoveryDecisionCandidate) => {
        const latest = deps.getState();
        const latestRun = latest.workerRuns.find((item) => item.runId === runId);
        return !!latestRun && JSON.stringify(latestRun) === JSON.stringify(candidate.state);
      },
    });
    if (admission.kind === 'replay') return;
    const admittedCandidate = admission.record.candidate;
    deps.assertProjectOperation(operation);
    deps.recordProjectEvents(projectId, admittedCandidate.events);
    const nextRuns = decisionState.workerRuns.map((item) => item.runId === runId ? admittedCandidate.state : item);
    decisionState.setWorkerRuns(nextRuns);
    decisionState.setOrchestrations(
      projectWorkerRunsOntoOrchestrations(decisionState.orchestrations, nextRuns),
    );
    decisionState.setWorkerCleanupProposals(decisionState.workerCleanupProposals.filter((proposal) => proposal.runId !== runId));
    const runtime = installWorkerRunRuntime({
      projectId,
      taskGraphs: decisionState.taskGraphs,
      runs: decisionState.workerRuns.map((item) => item.runId === runId ? admittedCandidate.state : item),
    });
    decisionState.setWorkerRunRecoveries(runtime.recoveries);
    deps.assertProjectOperation(operation);
    await deps.saveProject(projectId, projectPath, operation.controller.signal);
    deps.assertProjectOperation(operation);
    await decisionPersistence.commit({
      projectId,
      runId,
      requestIdentity: requestKey,
      action: decision,
      semanticPayloadVersion: 1,
      decisionId,
      factsFingerprint,
      candidate: admittedCandidate,
      now: new Date().toISOString(),
    });
    if (decision === 'retry') await deps.runQueuedWorker(runId, workerRuntime);
    } finally {
      lease.release();
    }
  };

  return { recoverWorkerRun };
}
