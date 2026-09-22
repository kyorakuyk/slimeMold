import { describe, expect, it, vi } from 'vitest';
import { createWorkerActionController } from './workerActionController';
import { createWorkerRecoverySingleFlight } from './workerRecoverySingleFlight';

function controller(isTauri: boolean) {
  return createWorkerActionController({
    getState: () => ({
      projectId: null,
      projectPath: null,
      workerRuns: [],
      workerRunSideEffects: [],
      workerRunRecoveries: [],
      workerCleanupProposals: [],
      orchestrations: [],
      taskGraphs: [],
      setWorkerRunSideEffects: vi.fn(),
      setWorkerRuns: vi.fn(),
      setOrchestrations: vi.fn(),
      setWorkerCleanupProposals: vi.fn(),
      setWorkerRunRecoveries: vi.fn(),
    }),
    getProjectOperation: vi.fn(() => ({
      projectId: null,
      projectPath: null,
      controller: new AbortController(),
    })),
    assertProjectOperation: vi.fn(),
    recordProjectEvents: vi.fn(),
    saveProject: vi.fn(async () => {}),
    runQueuedWorker: vi.fn(async () => {}),
    isTauri,
  }).recoverWorkerRun;
}

describe('worker action controller', () => {
  it('rejects recovery outside the desktop host', async () => {
    await expect(controller(false)('run-1', 'skip', 'manual')).rejects.toThrow('桌面端');
  });

  it('rejects recovery before a saved project and durable run exist', async () => {
    await expect(controller(true)('run-1', 'retry', 'manual')).rejects.toThrow('项目必须先保存');
  });

  it('rejects a duplicate same-project/run recovery before host admission and releases after failure', async () => {
    let resolveSession: ((session: null) => void) | undefined;
    const firstSession = new Promise<null>((resolve) => { resolveSession = resolve; });
    const state = {
      projectId: 'project-1',
      projectPath: 'C:/project',
      workerRuns: [{
        runId: 'run-1',
        projectId: 'project-1',
        taskGraphId: 'graph-1',
        tasks: {},
      } as never],
      workerRunSideEffects: [],
      workerRunRecoveries: [],
      workerCleanupProposals: [],
      orchestrations: [],
      taskGraphs: [{ id: 'graph-1' } as never],
      setWorkerRunSideEffects: vi.fn(),
      setWorkerRuns: vi.fn(),
      setOrchestrations: vi.fn(),
      setWorkerCleanupProposals: vi.fn(),
      setWorkerRunRecoveries: vi.fn(),
    };
    const ensureGuiDevSession = vi.fn(async () => firstSession as never);
    const recoverySingleFlight = createWorkerRecoverySingleFlight();
    const recoverWorkerRun = createWorkerActionController({
      getState: () => state,
      getProjectOperation: vi.fn(() => ({
        projectId: 'project-1',
        projectPath: 'C:/project',
        controller: new AbortController(),
      })),
      assertProjectOperation: vi.fn(),
      recordProjectEvents: vi.fn(),
      saveProject: vi.fn(async () => {}),
      runQueuedWorker: vi.fn(async () => {}),
      isTauri: true,
      ensureGuiDevSession,
      recoverySingleFlight,
    }).recoverWorkerRun;

    const first = recoverWorkerRun('run-1', 'skip', 'manual');
    await expect(recoverWorkerRun('run-1', 'retry', 'duplicate'))
      .rejects.toThrow('Worker Run 恢复正在处理中：run-1');
    expect(ensureGuiDevSession).toHaveBeenCalledTimes(1);

    resolveSession?.(null);
    await expect(first).rejects.toThrow('开发宿主不可用');

    let resolveSecond: ((session: null) => void) | undefined;
    const secondSession = new Promise<null>((resolve) => { resolveSecond = resolve; });
    ensureGuiDevSession.mockImplementationOnce(async () => secondSession as never);
    const second = recoverWorkerRun('run-1', 'skip', 'after-release');
    expect(ensureGuiDevSession).toHaveBeenCalledTimes(2);
    resolveSecond?.(null);
    await expect(second).rejects.toThrow('开发宿主不可用');
  });
});
