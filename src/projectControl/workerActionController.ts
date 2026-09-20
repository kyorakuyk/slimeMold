import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import type { Orchestration } from '../types';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectTaskGraph } from './types';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { WorkerCleanupProposal } from './workerCleanup';
import type { ProjectOperation } from './projectLifecycleController';
import { recoverWorkerRunCommand } from './workerRecoveryCommand';
import { installWorkerRunRuntime } from './workerRunRuntime';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';
import { mergeWorkerSideEffects } from './workerEvidence';
import { assertWorkerRecoveryDecisionPrecondition } from './workerRecoveryDecisionPrecondition';
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
  runQueuedWorker: (runId: string) => Promise<void>;
  isTauri: boolean;
  ensureGuiDevSession?: typeof defaultEnsureGuiDevSession;
  recoverySingleFlight?: WorkerRecoverySingleFlight;
}

export function createWorkerActionController(deps: WorkerActionControllerDeps): {
  recoverWorkerRun: (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
  ) => Promise<void>;
} {
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;
  const recoverySingleFlight = deps.recoverySingleFlight ?? createWorkerRecoverySingleFlight();

  const recoverWorkerRun = async (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
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
    const decisionId = globalThis.crypto?.randomUUID?.() ?? `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = recoverWorkerRunCommand({
      projectId,
      state: run,
      taskGraph,
      journal,
      decision,
      reason,
      decisionId,
      now: new Date().toISOString(),
    });
    deps.assertProjectOperation(operation);
    deps.recordProjectEvents(projectId, result.events);
    const nextRuns = decisionState.workerRuns.map((item) => item.runId === runId ? result.state : item);
    decisionState.setWorkerRuns(nextRuns);
    decisionState.setOrchestrations(
      projectWorkerRunsOntoOrchestrations(decisionState.orchestrations, nextRuns),
    );
    decisionState.setWorkerCleanupProposals(decisionState.workerCleanupProposals.filter((proposal) => proposal.runId !== runId));
    const runtime = installWorkerRunRuntime({
      projectId,
      taskGraphs: decisionState.taskGraphs,
      runs: decisionState.workerRuns.map((item) => item.runId === runId ? result.state : item),
    });
    decisionState.setWorkerRunRecoveries(runtime.recoveries);
    deps.assertProjectOperation(operation);
    await deps.saveProject(projectId, projectPath, operation.controller.signal);
    deps.assertProjectOperation(operation);
    if (decision === 'retry') await deps.runQueuedWorker(runId);
    } finally {
      lease.release();
    }
  };

  return { recoverWorkerRun };
}
