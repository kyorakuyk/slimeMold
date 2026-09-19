import { describe, expect, it, vi } from 'vitest';
import { createWorkerCleanupActionController, type WorkerCleanupActionState } from './workerCleanupActionController';

function state(overrides: Partial<WorkerCleanupActionState> = {}): WorkerCleanupActionState {
  return {
    projectId: null,
    projectPath: null,
    projectControl: { taskGraphs: [] },
    workerRuns: [],
    workerRunSideEffects: [],
    workerRunRecoveries: [],
    workerCleanupProposals: [],
    orchestrations: [],
    setWorkerRunSideEffects: vi.fn(),
    setWorkerRuns: vi.fn(),
    setOrchestrations: vi.fn(),
    setWorkerCleanupProposals: vi.fn(),
    setWorkerRunRecoveries: vi.fn(),
    saveProject: vi.fn(async () => undefined),
    workflowName: '',
    nodes: [],
    edges: [],
    agents: [],
    roles: [],
    variables: {},
    projectVariables: {},
    projectAssets: [],
    groups: [],
    activeWfId: '',
    workflows: {},
    projectName: null,
    projectCreatedAt: null,
    subgraphs: {},
    runHistory: [],
    artifacts: {},
    agentRouteTable: {},
    pipelines: [],
    ...overrides,
  } as WorkerCleanupActionState;
}

function controller(current: WorkerCleanupActionState, isTauri = true) {
  return createWorkerCleanupActionController({
    getState: () => current,
    getProjectOperation: () => ({
      projectId: current.projectId,
      projectPath: current.projectPath,
      controller: new AbortController(),
    }),
    assertProjectOperation: vi.fn(),
    recordProjectEvents: vi.fn(),
    refreshWorkerCleanupProposals: vi.fn(async () => undefined),
    isTauri,
    ensureGuiDevSession: vi.fn(async () => null),
  });
}

describe('worker cleanup action controller', () => {
  it('rejects cleanup outside the desktop host before reading state', async () => {
    const getState = vi.fn(() => state());
    const cleanup = createWorkerCleanupActionController({
      getState,
      getProjectOperation: vi.fn(),
      assertProjectOperation: vi.fn(),
      recordProjectEvents: vi.fn(),
      refreshWorkerCleanupProposals: vi.fn(async () => undefined),
      isTauri: false,
    }).cleanupWorkerRun;

    await expect(cleanup('run-1', 'task-1', 'cleanup')).rejects.toThrow('桌面端');
    expect(getState).not.toHaveBeenCalled();
  });

  it('rejects cleanup when the project is not saved', async () => {
    await expect(controller(state()).cleanupWorkerRun('run-1', 'task-1', 'cleanup'))
      .rejects.toThrow('项目必须先保存');
  });

  it('rejects cleanup when the proposal is missing or not ready', async () => {
    const current = state({ projectId: 'project-1', projectPath: 'C:/project-1' });
    await expect(controller(current).cleanupWorkerRun('run-1', 'task-1', 'cleanup'))
      .rejects.toThrow('清理提案不可用');
  });
});
