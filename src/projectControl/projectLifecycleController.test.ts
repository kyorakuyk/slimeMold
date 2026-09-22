import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectLifecycleController,
  type ProjectLifecycleState,
  type ProjectOperation,
} from './projectLifecycleController';

function operation(projectId: string | null, projectPath: string | null): ProjectOperation {
  return { projectId, projectPath, controller: new AbortController() };
}

function state(overrides: Partial<ProjectLifecycleState> = {}): ProjectLifecycleState {
  return {
    projectId: null,
    projectPath: null,
    workerRuns: [],
    workerRunRecoveries: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('project lifecycle controller', () => {
  it('observes the initial project and cleans up its subscription and operation', () => {
    let listener: ((next: ProjectLifecycleState) => void) | null = null;
    const showWelcome = vi.fn();
    const clearProjectOperation = vi.fn();
    const controller = createProjectLifecycleController({
      getState: () => state(),
      subscribe: (next) => {
        listener = next;
        return () => { listener = null; };
      },
      setShowWelcome: showWelcome,
      getProjectOperation: vi.fn((projectId, projectPath) => operation(projectId, projectPath)),
      clearProjectOperation,
      reportWarning: vi.fn(),
      restoreWorkerWorktrees: vi.fn(async () => {}),
      loadProjectWorkerEvidence: vi.fn(async () => {}),
      auditLoadedWorkerRunFacts: vi.fn(async () => {}),
      refreshWorkerCleanupProposals: vi.fn(async () => {}),
      recoverInterruptedWorkerEffects: vi.fn(async () => {}),
    });

    controller.start();

    expect(showWelcome).not.toHaveBeenCalled();
    expect(listener).toEqual(expect.any(Function));

    controller.dispose();

    expect(clearProjectOperation).toHaveBeenCalledTimes(1);
    expect(listener).toBeNull();
  });

  it('preserves warning logs for recovery and evidence scheduling failures', async () => {
    const reportWarning = vi.fn();
    const session = { listAcceptances: () => [] };
    const controller = createProjectLifecycleController({
      getState: () => state({
        projectId: 'project-1',
        projectPath: 'C:/project-1',
        workerRunRecoveries: [{ runId: 'run-1' } as never],
      }),
      subscribe: (listener) => () => listener,
      setShowWelcome: vi.fn(),
      getProjectOperation: vi.fn((projectId, projectPath) => operation(projectId, projectPath)),
      clearProjectOperation: vi.fn(),
      reportWarning,
      restoreWorkerWorktrees: vi.fn(async () => {}),
      loadProjectWorkerEvidence: vi.fn(async () => { throw new Error('evidence failed'); }),
      auditLoadedWorkerRunFacts: vi.fn(async () => {}),
      refreshWorkerCleanupProposals: vi.fn(async () => {}),
      recoverInterruptedWorkerEffects: vi.fn(async () => { throw new Error('recovery failed'); }),
      ensureGuiDevSession: vi.fn(async () => session) as never,
      teardownGuiDevSession: vi.fn(async () => {}),
      scanProjectCustomNodes: vi.fn(async () => 0),
      terminatePluginRuntime: vi.fn(),
      unloadProjectCustomNodes: vi.fn(),
    });

    controller.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(reportWarning).toHaveBeenCalledWith('Worker recovery 调度失败：recovery failed');
    expect(reportWarning).toHaveBeenCalledWith('Worker Evidence 调度失败：evidence failed');
    controller.dispose();
  });
  it('runs the project transition lifecycle through injected Worker boundaries', async () => {
    const projectState = state({ projectId: 'project-1', projectPath: 'C:/project-1' });
    const session = { listAcceptances: () => [] };
    const ensureGuiDevSession = vi.fn(async () => session);
    const teardownGuiDevSession = vi.fn(async () => {});
    const restoreWorkerWorktrees = vi.fn(async () => {});
    const loadProjectWorkerEvidence = vi.fn(async () => {});
    const auditLoadedWorkerRunFacts = vi.fn(async () => {});
    const refreshWorkerCleanupProposals = vi.fn(async () => {});
    const recoverInterruptedWorkerEffects = vi.fn(async () => {});
    const controller = createProjectLifecycleController({
      getState: () => projectState,
      subscribe: (listener) => () => listener,
      setShowWelcome: vi.fn(),
      getProjectOperation: vi.fn((projectId, projectPath) => operation(projectId, projectPath)),
      clearProjectOperation: vi.fn(),
      reportWarning: vi.fn(),
      restoreWorkerWorktrees,
      loadProjectWorkerEvidence,
      auditLoadedWorkerRunFacts,
      refreshWorkerCleanupProposals,
      recoverInterruptedWorkerEffects,
      ensureGuiDevSession: ensureGuiDevSession as never,
      teardownGuiDevSession,
      scanProjectCustomNodes: vi.fn(async () => 0),
      terminatePluginRuntime: vi.fn(),
      unloadProjectCustomNodes: vi.fn(),
    });

    controller.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ensureGuiDevSession).toHaveBeenCalledWith('C:/project-1', expect.any(AbortSignal));
    expect(restoreWorkerWorktrees).toHaveBeenCalledWith(session, [], expect.any(AbortSignal));
    expect(auditLoadedWorkerRunFacts).toHaveBeenCalledWith(
      'C:/project-1',
      [],
      expect.any(AbortSignal),
    );
    expect(recoverInterruptedWorkerEffects).toHaveBeenCalledWith('C:/project-1', [], expect.any(AbortSignal));

    controller.dispose();
  });
});
