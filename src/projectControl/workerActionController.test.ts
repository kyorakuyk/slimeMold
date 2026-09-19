import { describe, expect, it, vi } from 'vitest';
import { createWorkerActionController } from './workerActionController';

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
});
