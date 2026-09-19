import {
  ensureGuiDevSession as defaultEnsureGuiDevSession,
  teardownGuiDevSession as defaultTeardownGuiDevSession,
} from '../dev/gui';
import {
  scanProjectCustomNodes as defaultScanProjectCustomNodes,
  terminatePluginRuntime as defaultTerminatePluginRuntime,
  unloadProjectCustomNodes as defaultUnloadProjectCustomNodes,
} from '../plugins/pluginManager';
import { createProjectPluginLifecycleScheduler } from '../plugins/projectPluginLifecycle';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from './workerRunRuntime';

export type ProjectOperation = {
  projectId: string | null;
  projectPath: string | null;
  controller: AbortController;
};

export type ProjectLifecycleState = {
  projectId: string | null;
  projectPath: string | null;
  workerRuns: readonly WorkerRunQueueState[];
  workerRunRecoveries: readonly WorkerRunRecovery[];
};

type GuiProjectSession = NonNullable<Awaited<ReturnType<typeof defaultEnsureGuiDevSession>>>;

type EnsureGuiDevSession = typeof defaultEnsureGuiDevSession;
type ScanProjectCustomNodes = typeof defaultScanProjectCustomNodes;

export interface ProjectLifecycleControllerDeps {
  getState: () => ProjectLifecycleState;
  subscribe: (listener: (state: ProjectLifecycleState) => void) => () => void;
  setShowWelcome: (show: boolean) => void;
  getProjectOperation: (projectId: string | null, projectPath: string | null) => ProjectOperation;
  clearProjectOperation: () => void;
  restoreWorkerWorktrees: (
    session: GuiProjectSession,
    runs: readonly WorkerRunQueueState[],
    signal?: AbortSignal,
  ) => Promise<void>;
  loadProjectWorkerEvidence: (projectPath: string | null, signal?: AbortSignal) => Promise<void>;
  auditLoadedWorkerRunFacts: (
    projectPath: string | null,
    acceptances?: ReadonlyArray<ReturnType<GuiProjectSession['listAcceptances']>[number]>,
    signal?: AbortSignal,
  ) => Promise<void>;
  refreshWorkerCleanupProposals: (
    session: GuiProjectSession,
    runId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  recoverInterruptedWorkerEffects: (
    projectPath: string | null,
    runIds: string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  ensureGuiDevSession?: EnsureGuiDevSession;
  teardownGuiDevSession?: typeof defaultTeardownGuiDevSession;
  scanProjectCustomNodes?: ScanProjectCustomNodes;
  terminatePluginRuntime?: typeof defaultTerminatePluginRuntime;
  unloadProjectCustomNodes?: typeof defaultUnloadProjectCustomNodes;
}

export interface ProjectLifecycleController {
  start: () => void;
  dispose: () => void;
}

export function createProjectLifecycleController(
  deps: ProjectLifecycleControllerDeps,
): ProjectLifecycleController {
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;
  const teardownGuiDevSession = deps.teardownGuiDevSession ?? defaultTeardownGuiDevSession;
  const scanProjectCustomNodes = deps.scanProjectCustomNodes ?? defaultScanProjectCustomNodes;
  const terminatePluginRuntime = deps.terminatePluginRuntime ?? defaultTerminatePluginRuntime;
  const unloadProjectCustomNodes = deps.unloadProjectCustomNodes ?? defaultUnloadProjectCustomNodes;

  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let lastRecoveryKey = '';
  let lastEvidencePath: string | null = null;
  let sessionTransition: Promise<void> = Promise.resolve();

  const scheduleRecovery = (state: ProjectLifecycleState): void => {
    if (!state.projectId) {
      lastRecoveryKey = '';
      return;
    }
    const runIds = state.workerRunRecoveries.map((item) => item.runId);
    const key = `${state.projectId}:${state.projectPath}:${runIds.join(',')}`;
    if (key === lastRecoveryKey) return;
    lastRecoveryKey = key;
    const operation = deps.getProjectOperation(state.projectId, state.projectPath);
    void deps.recoverInterruptedWorkerEffects(
      state.projectPath,
      runIds,
      operation.controller.signal,
    ).catch(() => {
      // The recovery function owns durable recovery/error projection.
    });
  };

  const scheduleEvidence = (state: ProjectLifecycleState): void => {
    if (!state.projectId || !state.projectPath) {
      lastEvidencePath = null;
      return;
    }
    if (state.projectPath === lastEvidencePath) return;
    lastEvidencePath = state.projectPath;
    const operation = deps.getProjectOperation(state.projectId, state.projectPath);
    void deps.loadProjectWorkerEvidence(state.projectPath, operation.controller.signal).catch(() => {
      // The evidence loader owns durable recovery/error projection.
    });
  };

  const reloadProjectCustomNodes = (
    state: Pick<ProjectLifecycleState, 'projectId' | 'projectPath'>,
    signal?: AbortSignal,
  ): void => {
    terminatePluginRuntime();
    unloadProjectCustomNodes();
    if (state.projectId) {
      void scanProjectCustomNodes({
        projectId: state.projectId,
        projectPath: state.projectPath,
        signal,
      }).catch(() => {});
    }
  };

  const projectLifecycle = createProjectPluginLifecycleScheduler(({ previous, next, epoch }) => {
    const operation = deps.getProjectOperation(next.projectId, next.projectPath);
    reloadProjectCustomNodes(next, operation.controller.signal);
    sessionTransition = sessionTransition
      .catch(() => {})
      .then(async () => {
        if (operation.controller.signal.aborted) return;
        if (previous?.projectId) await teardownGuiDevSession();
        if (operation.controller.signal.aborted || !projectLifecycle.isCurrent(epoch, next) || !next.projectId) return;
        const session = await ensureGuiDevSession(next.projectPath, operation.controller.signal);
        if (operation.controller.signal.aborted || !projectLifecycle.isCurrent(epoch, next)) return;
        if (!session) return;
        await deps.restoreWorkerWorktrees(session, deps.getState().workerRuns, operation.controller.signal);
        if (operation.controller.signal.aborted) return;
        await deps.loadProjectWorkerEvidence(next.projectPath, operation.controller.signal);
        if (operation.controller.signal.aborted || !projectLifecycle.isCurrent(epoch, next)) return;
        await deps.auditLoadedWorkerRunFacts(
          next.projectPath,
          session.listAcceptances(),
          operation.controller.signal,
        );
        if (operation.controller.signal.aborted || !projectLifecycle.isCurrent(epoch, next)) return;
        const restoredRuns = deps.getState().workerRuns;
        for (const run of restoredRuns) {
          if (operation.controller.signal.aborted || !projectLifecycle.isCurrent(epoch, next)) return;
          await deps.refreshWorkerCleanupProposals(session, run.runId, operation.controller.signal);
        }
      })
      .catch(() => {
        // The individual lifecycle operation owns its visible error projection.
      });
  });

  const observe = (state: ProjectLifecycleState): void => {
    if (disposed) return;
    deps.setShowWelcome(!state.projectId);
    deps.getProjectOperation(state.projectId, state.projectPath);
    projectLifecycle.observe({ projectId: state.projectId, projectPath: state.projectPath });
    scheduleRecovery(state);
    scheduleEvidence(state);
  };

  return {
    start() {
      if (disposed || unsubscribe) return;
      const initialState = deps.getState();
      deps.getProjectOperation(initialState.projectId, initialState.projectPath);
      projectLifecycle.observe({
        projectId: initialState.projectId,
        projectPath: initialState.projectPath,
      });
      scheduleRecovery(initialState);
      scheduleEvidence(initialState);
      unsubscribe = deps.subscribe(observe);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      deps.clearProjectOperation();
      projectLifecycle.dispose();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
