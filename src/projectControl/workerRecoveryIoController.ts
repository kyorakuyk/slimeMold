import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import { isTauri as defaultIsTauri } from '../platform/env';
import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { Orchestration } from '../types/orchestration';
import type { EvidenceRecord } from '../dev/evidence';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { WorkerCleanupProposal } from './workerCleanup';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';
import { mergeWorkerEvidence, mergeWorkerSideEffects } from './workerEvidence';
import {
  createWorkerEvidenceRepositoryBundleFromModules,
  createWorkerHostRepositoryBundleFromModules,
  loadWorkerEvidenceRepositoryModules,
  loadWorkerHostRepositoryModules,
} from './workerHostRepositoryBundle';
import { cleanupUnknownRunIds, reconcileSuccessfulCleanupReceipts } from './workerRecoveryFacts';

type ProjectSave = (
  projectId: string,
  projectPath: string,
  signal?: AbortSignal,
) => Promise<void>;

export interface WorkerRecoveryIoState {
  projectId: string | null;
  projectPath: string | null;
  workerRuns: WorkerRunQueueState[];
  workerRunRecoveries: WorkerRunRecovery[];
  workerRunEvidence: EvidenceRecord[];
  workerRunSideEffects: SideEffectRecord[];
  workerCleanupProposals: WorkerCleanupProposal[];
  orchestrations: Orchestration[];
  setWorkerRunEvidence: (evidence: EvidenceRecord[]) => void;
  setWorkerRunSideEffects: (effects: SideEffectRecord[]) => void;
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  setOrchestrations: (orchestrations: Orchestration[]) => void;
  setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => void;
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
}

export interface WorkerRecoveryIoControllerDeps {
  getState: () => WorkerRecoveryIoState;
  recordProjectEvents: (projectId: string, events: readonly DomainEvent[]) => void;
  saveProject: ProjectSave;
  reportWarning: (message: string) => void;
  isTauri?: boolean;
  ensureGuiDevSession?: typeof defaultEnsureGuiDevSession;
}

export function createWorkerRecoveryIoController(
  deps: WorkerRecoveryIoControllerDeps,
): {
  recoverInterruptedWorkerEffects: (
    projectPath: string | null,
    runIds: string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  loadProjectWorkerEvidence: (
    projectPath: string | null,
    signal?: AbortSignal,
  ) => Promise<void>;
} {
  const isDesktop = deps.isTauri ?? defaultIsTauri;
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;

  const recoverInterruptedWorkerEffects = async (
    projectPath: string | null,
    runIds: string[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!isDesktop || !projectPath || runIds.length === 0 || signal?.aborted) return;
    try {
      const modulesPromise = loadWorkerHostRepositoryModules();
      const session = await ensureGuiDevSession(projectPath, signal);
      if (!session) throw new Error('开发宿主不可用，无法恢复 Worker Acceptance');
      const bundle = createWorkerHostRepositoryBundleFromModules(
        {
          projectPath,
          listAcceptances: () => session.listAcceptances(),
        },
        await modulesPromise,
      );
      const recorder = bundle.sideEffects;
      for (const runId of runIds) {
        if (signal?.aborted) return;
        await recorder.recoverInterruptedRun(runId, { signal });
      }
    } catch (cause) {
      if (signal?.aborted) return;
      deps.reportWarning(
        `Worker 副作用账本无法完成恢复核对：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const loadProjectWorkerEvidence = async (
    projectPath: string | null,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!isDesktop || !projectPath || signal?.aborted) return;
    try {
      const modulesPromise = loadWorkerEvidenceRepositoryModules();
      const repositories = createWorkerEvidenceRepositoryBundleFromModules(
        { projectPath },
        await modulesPromise,
      );
      if (signal?.aborted) return;
      const records = await repositories.loadEvidence();
      if (signal?.aborted) return;
      const effects = await repositories.loadSideEffects();
      if (signal?.aborted) return;
      const current = deps.getState();
      if (current.projectPath !== projectPath) return;
      const mergedEffects = mergeWorkerSideEffects(current.workerRunSideEffects, effects);
      const reconciled = reconcileSuccessfulCleanupReceipts(current.workerRuns, mergedEffects);
      current.setWorkerRunEvidence(mergeWorkerEvidence(current.workerRunEvidence, records));
      current.setWorkerRunSideEffects(mergedEffects);
      if (reconciled.events.length > 0 && current.projectId) {
        deps.recordProjectEvents(current.projectId, reconciled.events);
        current.setWorkerRuns(reconciled.runs);
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, reconciled.runs),
        );
        await deps.saveProject(current.projectId, projectPath, signal);
      }
      const cleanupUnknownRuns = cleanupUnknownRunIds(mergedEffects);
      if (cleanupUnknownRuns.size > 0) {
        current.setWorkerRunRecoveries([
          ...current.workerRunRecoveries.filter((item) => !cleanupUnknownRuns.has(item.runId)),
          ...current.workerRuns
            .filter((run) => cleanupUnknownRuns.has(run.runId))
            .map((run): WorkerRunRecovery => ({
              runId: run.runId,
              projectId: run.projectId,
              reason: 'cleanup-unknown',
              message: 'Cleanup 副作用为 unknown/needs-user，必须人工核对后才能继续。',
            })),
        ]);
        current.setWorkerCleanupProposals(
          current.workerCleanupProposals.filter((proposal) => !cleanupUnknownRuns.has(proposal.runId)),
        );
      }
    } catch (cause) {
      if (signal?.aborted) return;
      const current = deps.getState();
      const message = `Worker Evidence/Receipt reconciliation 无法持久化：${cause instanceof Error ? cause.message : String(cause)}`;
      current.setWorkerRunRecoveries(current.workerRuns.map((run): WorkerRunRecovery => ({
        runId: run.runId,
        projectId: run.projectId,
        reason: 'event-stream-invalid',
        message,
      })));
      current.setWorkerCleanupProposals([]);
      deps.reportWarning(message);
      throw cause;
    }
  };

  return { recoverInterruptedWorkerEffects, loadProjectWorkerEvidence };
}
