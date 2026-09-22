import { EventStreamRepository } from '../domain/eventStore';
import { isTauri as defaultIsTauri } from '../platform/env';
import { ensureGuiDevSession, getDevGuiError } from '../dev/gui';
import { saveProjectFile } from '../io/projectIO';
import { buildProjectFile } from '../store/workflowSerialize';
import { recordProjectEvents, flushPendingProjectEvents } from '../projectControl/eventBuffer';
import { createGuiProjectWorkerRunCoordinator, type WorkerRuntime } from '../projectControl/workerRunCoordinator';
import { installWorkerRunRuntime } from '../projectControl/workerRunRuntime';
import { auditWorkerRunConsistency } from '../projectControl/workerRunConsistency';
import { ensureProjectControlEventBaseline } from '../projectControl/eventSourceBootstrap';
import { auditProjectControlConsistency } from '../projectControl/projectControlConsistency';
import {
  projectWorkerRunsOntoOrchestrations,
  suppressInvalidWorkerRunProjection,
} from '../projectControl/workerRunOrchestrationProjection';
import {
  reconcileWorkerRunsFromEvents,
  rehydrateWorkerRunsFromEvents,
} from '../projectControl/workerRunRehydration';
import { mergeWorkerEvidence, mergeWorkerSideEffects } from '../projectControl/workerEvidence';
import { createWorkerRecoveryIoController } from '../projectControl/workerRecoveryIoController';
import { createWorkerActionController } from '../projectControl/workerActionController';
import type { WorkerRecoverySingleFlight } from '../projectControl/workerRecoverySingleFlight';
import { createWorkerCleanupActionController } from '../projectControl/workerCleanupActionController';
import { createWorkerCleanupProposalController } from '../projectControl/workerCleanupProposalController';
import { assertWorkerRunConsistency } from '../projectControl/workerRunConsistencyAction';
import { createWorkerRunTransitionPersistence } from '../projectControl/workerRunTransitionPersistence';
import { createWorkerRunHostInfrastructure } from '../projectControl/workerRunHostInfrastructure';
import { admitWorkerRunSession } from '../projectControl/workerRunSessionAdmission';
import { createWorkerRunRecoveryAuditController } from '../projectControl/workerRunRecoveryAuditController';
import { restoreWorkerWorktrees as restoreWorkerWorktreesFromState } from '../projectControl/workerWorktreeRestore';
import type { ProjectOperationGuard } from '../projectControl/projectOperation';
import type { WorkflowState } from '../store/workflowStoreTypes';

export interface AppWorkerRuntimeStore {
  getState: () => WorkflowState;
}

export interface AppWorkerRuntimeDependencies {
  store: AppWorkerRuntimeStore;
  isTauri?: boolean;
  recoverySingleFlight: WorkerRecoverySingleFlight;
  getProjectOperation: ProjectOperationGuard['get'];
  assertProjectOperation: ProjectOperationGuard['assert'];
}

/**
 * 应用级 Worker runtime composition root。
 *
 * App 只保留 React 生命周期和 UI 事件接线；Worker queue、recovery、evidence、
 * cleanup controller 的组合在这里完成。底层 controller 仍然通过显式 ports 读写 store，
 * 不把 React hooks 或 App 组件状态带入 projectControl。
 */
export function createAppWorkerRuntime(deps: AppWorkerRuntimeDependencies) {
  const isTauri = deps.isTauri ?? defaultIsTauri;
  const store = deps.store;
  const workerRecoveryIo = createWorkerRecoveryIoController({
    getState: store.getState,
    recordProjectEvents,
    saveProject: async (projectId, projectPath, signal) => {
      await store.getState().saveProject({ projectId, projectPath, signal });
    },
    reportWarning: (message) => store.getState().addLog('warn', message),
  });
  const {
    recoverInterruptedWorkerEffects,
    loadProjectWorkerEvidence,
  } = workerRecoveryIo;

  const workerCleanupProposalController = createWorkerCleanupProposalController({
    getState: store.getState,
  });
  const refreshWorkerCleanupProposals = workerCleanupProposalController.refresh;

  const restoreWorkerWorktrees = (
    session: NonNullable<Awaited<ReturnType<typeof ensureGuiDevSession>>>,
    runs: Parameters<typeof restoreWorkerWorktreesFromState>[0]['runs'],
    signal?: AbortSignal,
  ): Promise<void> => restoreWorkerWorktreesFromState({
    session,
    runs,
    signal,
    warn: (message) => store.getState().addLog('warn', message),
  });

  const workerRunRecoveryAuditController = createWorkerRunRecoveryAuditController({
    isTauri,
    getState: () => {
      const state = store.getState();
      return {
        projectId: state.projectId,
        projectPath: state.projectPath,
        projectControl: state.projectControl,
        workerRuns: state.workerRuns,
        orchestrations: state.orchestrations,
        workerRunEvidence: state.workerRunEvidence,
        workerRunSideEffects: state.workerRunSideEffects,
      };
    },
    setWorkerRuns: (runs) => store.getState().setWorkerRuns(runs),
    setOrchestrations: (orchestrations) => store.getState().setOrchestrations(orchestrations),
    setWorkerRunRecoveries: (recoveries) => store.getState().setWorkerRunRecoveries(recoveries),
    setWorkerCleanupProposals: (proposals) => store.getState().setWorkerCleanupProposals(proposals),
    addLog: (level, message) => store.getState().addLog(level, message),
    saveProject: async (projectId, projectPath, signal) => (
      store.getState().saveProject({ projectId, projectPath, signal })
    ),
    createEventRepository: async (projectPath) => {
      const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
      return new EventStreamRepository(
        createTauriEventStoreAdapter(projectPath),
        projectPath,
      );
    },
    ensureEventBaseline: ensureProjectControlEventBaseline,
    reconcileWorkerRunsFromEvents,
    rehydrateWorkerRunsFromEvents,
    auditWorkerRunConsistency,
    auditProjectControlConsistency,
    installWorkerRunRuntime,
    projectWorkerRunsOntoOrchestrations,
    suppressInvalidWorkerRunProjection,
    now: () => new Date().toISOString(),
  });
  const auditLoadedWorkerRunFacts = workerRunRecoveryAuditController.auditLoadedWorkerRunFacts;

  const runQueuedWorker = async (runId: string, workerRuntime: WorkerRuntime = 'codex'): Promise<void> => {
    const beforeSave = store.getState();
    const projectId = beforeSave.projectId;
    const projectPath = beforeSave.projectPath;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，Worker 才能创建隔离 worktree');
    const operation = deps.getProjectOperation(projectId, projectPath);
    deps.assertProjectOperation(operation);

    const session = await admitWorkerRunSession({
      projectId,
      projectPath,
      signal: operation.controller.signal,
      saveProject: beforeSave.saveProject,
      assertOperation: () => deps.assertProjectOperation(operation),
      ensureGuiDevSession,
      getDevGuiError,
      getCurrentProjectId: () => store.getState().projectId,
    });
    const current = store.getState();
    const infrastructure = await createWorkerRunHostInfrastructure({
      projectPath,
      listAcceptances: () => session.listAcceptances(),
      assertOperation: () => deps.assertProjectOperation(operation),
    });

    const antigravityAgent = [...current.globalAgents, ...current.agents].find(
      (agent) => agent.protocol === 'antigravity' && agent.enabled !== false,
    );
    const coordinator = createGuiProjectWorkerRunCoordinator({
      projectId,
      projectPath,
      runs: current.workerRuns,
      session,
      workerRuntime,
      antigravity: antigravityAgent
        ? {
          mode: antigravityAgent.runtimeMode,
          profile: antigravityAgent.runtimeProfile,
          cliPath: antigravityAgent.runtimeCliPath,
        }
        : undefined,
      concurrency: current.maxConcurrency,
      sideEffects: infrastructure.sideEffects,
      signal: operation.controller.signal,
      assertConsistency: async () => {
        await assertWorkerRunConsistency({
          projectId,
          getState: store.getState,
          assertOperation: () => deps.assertProjectOperation(operation),
          readEventStream: () => infrastructure.eventRepository.readStream(),
          listAcceptances: () => session.listAcceptances(),
          auditWorkerRunConsistency,
          auditProjectControlConsistency,
        });
      },
      persistTransition: createWorkerRunTransitionPersistence({
        projectId,
        projectPath,
        signal: operation.controller.signal,
        beforeSave,
        getState: store.getState,
        assertOperation: () => deps.assertProjectOperation(operation),
        recordProjectEvents,
        flushPendingProjectEvents,
        eventRepository: infrastructure.eventRepository,
        saveProjectFile,
        buildProjectFile,
        loadSideEffects: infrastructure.loadSideEffects,
        collectorEvidence: () => session.collector.records,
        mergeWorkerEvidence,
        mergeWorkerSideEffects,
      }),
    });
    deps.assertProjectOperation(operation);
    await coordinator.run(runId);
    deps.assertProjectOperation(operation);
    await refreshWorkerCleanupProposals(session, runId, operation.controller.signal);
  };

  const workerActionController = createWorkerActionController({
    getState: () => {
      const state = store.getState();
      return {
        ...state,
        taskGraphs: state.projectControl.taskGraphs ?? [],
      };
    },
    getProjectOperation: deps.getProjectOperation,
    assertProjectOperation: deps.assertProjectOperation,
    recordProjectEvents,
    saveProject: async (projectId, projectPath, signal) => {
      await store.getState().saveProject({ projectId, projectPath, signal });
    },
    runQueuedWorker,
    isTauri,
    recoverySingleFlight: deps.recoverySingleFlight,
  });

  const workerCleanupActionController = createWorkerCleanupActionController({
    getState: store.getState,
    getProjectOperation: deps.getProjectOperation,
    assertProjectOperation: deps.assertProjectOperation,
    recordProjectEvents,
    refreshWorkerCleanupProposals,
    isTauri,
  });

  return {
    recoverInterruptedWorkerEffects,
    loadProjectWorkerEvidence,
    restoreWorkerWorktrees,
    auditLoadedWorkerRunFacts,
    refreshWorkerCleanupProposals,
    runQueuedWorker,
    recoverWorkerRun: workerActionController.recoverWorkerRun,
    cleanupWorkerRun: workerCleanupActionController.cleanupWorkerRun,
  };
}
