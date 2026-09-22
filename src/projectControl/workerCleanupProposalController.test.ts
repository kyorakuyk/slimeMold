import { describe, expect, it, vi } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerCleanupProposal } from './workerCleanup';
import {
  createWorkerCleanupProposalController,
  type GuiProjectSession,
  type WorkerCleanupProposalRefreshState,
} from './workerCleanupProposalController';

const run = (runId: string): WorkerRunQueueState => ({
  version: 1,
  projectId: 'project-1',
  runId,
  orchestrationId: 'orch-1',
  taskGraphId: 'graph-1',
  taskGraphVersion: 1,
  status: 'succeeded',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  tasks: {},
});

const state = (overrides: Partial<WorkerCleanupProposalRefreshState> = {}) => {
  const setWorkerCleanupProposals = vi.fn();
  const addLog = vi.fn();
  const current: WorkerCleanupProposalRefreshState = {
    projectId: 'project-1',
    projectControl: { taskGraphs: [] },
    workerRuns: [run('run-1')],
    workerRunRecoveries: [],
    workerRunSideEffects: [],
    workerCleanupProposals: [
      { status: 'blocked', runId: 'run-1', taskId: 'task-1', reason: 'old' },
    ] as WorkerCleanupProposal[],
    setWorkerCleanupProposals,
    addLog,
    ...overrides,
  };
  return { current, setWorkerCleanupProposals, addLog };
};

const sessionMock = {
  getAcceptance: vi.fn(),
  manager: {
    isTracked: vi.fn(() => false),
    getBranchRevision: vi.fn(async () => undefined),
  },
  computeWorktreeSignature: vi.fn(async () => 'signature'),
};
const session = sessionMock as unknown as GuiProjectSession;

describe('worker cleanup proposal controller', () => {
  it('removes proposals for missing or recovery-blocked runs', async () => {
    const missing = state({ workerRuns: [] });
    await createWorkerCleanupProposalController({ getState: () => missing.current })
      .refresh(session, 'run-1');
    expect(missing.setWorkerCleanupProposals).toHaveBeenCalledWith([]);

    const recovery = state({ workerRunRecoveries: [{ runId: 'run-1' }] as never });
    await createWorkerCleanupProposalController({ getState: () => recovery.current })
      .refresh(session, 'run-1');
    expect(recovery.setWorkerCleanupProposals).toHaveBeenCalledWith([]);
  });

  it('fails closed when the restored run is unavailable and reports the warning', async () => {
    const current = state();
    const controller = createWorkerCleanupProposalController({ getState: () => current.current });
    await controller.refresh(session, 'run-1');
    expect(current.addLog).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('未通过 TaskGraph restore'),
    );
    expect(current.setWorkerCleanupProposals).toHaveBeenCalledWith([]);
  });

  it('does nothing after abort before or during host reads', async () => {
    const current = state();
    const controller = createWorkerCleanupProposalController({ getState: () => current.current });
    const before = new AbortController();
    before.abort();
    await controller.refresh(session, 'run-1', before.signal);
    expect(current.setWorkerCleanupProposals).not.toHaveBeenCalled();

    const during = new AbortController();
    sessionMock.computeWorktreeSignature.mockImplementationOnce(async () => {
      during.abort();
      return 'signature';
    });
    await controller.refresh(session, 'run-1', during.signal);
    expect(current.setWorkerCleanupProposals).toHaveBeenCalledWith([]);
  });
});
