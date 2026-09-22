import { describe, expect, it, vi } from 'vitest';
import type { ParsedEventStream } from '../domain/eventStore';
import type { AcceptanceRecord } from '../dev/session';
import { createEmptyProjectControlSnapshot } from './persistence';
import { assertWorkerRunConsistency } from './workerRunConsistencyAction';

const parsed = (overrides: Partial<ParsedEventStream> = {}): ParsedEventStream => ({
  status: 'ok',
  events: [],
  lastSequence: 0,
  ...overrides,
});

const base = () => ({
  workerRuns: [],
  workerRunEvidence: [],
  workerRunSideEffects: [],
  projectControl: createEmptyProjectControlSnapshot(),
});

const audits = () => ({
  worker: vi.fn(() => ({ ok: true, issues: [] as Array<{ message: string }> })),
  control: vi.fn(() => ({ ok: true, issues: [] as Array<{ message: string }> })),
});

describe('assertWorkerRunConsistency', () => {
  it('asserts operation around the event read and passes canonical audit inputs', async () => {
    const state = base();
    const audit = audits();
    const assertOperation = vi.fn();
    const readEventStream = vi.fn(async () => parsed());
    const acceptances = [] as AcceptanceRecord[];

    await assertWorkerRunConsistency({
      projectId: 'project-1',
      getState: () => state,
      assertOperation,
      readEventStream,
      listAcceptances: () => acceptances,
      auditWorkerRunConsistency: audit.worker,
      auditProjectControlConsistency: audit.control,
    });

    expect(assertOperation).toHaveBeenCalledTimes(3);
    expect(audit.worker).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      events: [],
      runs: state.workerRuns,
      evidence: state.workerRunEvidence,
      sideEffects: state.workerRunSideEffects,
      acceptances,
      taskGraphs: [],
    }));
    expect(audit.control).toHaveBeenCalledWith({
      projectId: 'project-1',
      snapshot: state.projectControl,
      events: [],
    });
  });

  it('fails closed on repaired event streams and canonical audit failures', async () => {
    const state = base();
    const audit = audits();
    const common = {
      projectId: 'project-1',
      getState: () => state,
      assertOperation: vi.fn(),
      listAcceptances: () => [] as AcceptanceRecord[],
      auditWorkerRunConsistency: audit.worker,
      auditProjectControlConsistency: audit.control,
    };

    await expect(assertWorkerRunConsistency({
      ...common,
      readEventStream: async () => parsed({
        status: 'needs-repair',
        corruption: { line: 4, raw: 'bad', tail: 'bad', reason: 'checksum' },
      }),
    })).rejects.toThrow('Worker 事件流需要修复：第 4 行 checksum');

    audit.worker.mockReturnValueOnce({ ok: false, issues: [{ message: 'worker drift' }] });
    await expect(assertWorkerRunConsistency({
      ...common,
      readEventStream: async () => parsed(),
    })).rejects.toThrow('Worker 事实源不一致：worker drift');

    audit.worker.mockReturnValueOnce({ ok: true, issues: [] });
    audit.control.mockReturnValueOnce({ ok: false, issues: [{ message: 'control drift' }] });
    await expect(assertWorkerRunConsistency({
      ...common,
      readEventStream: async () => parsed(),
    })).rejects.toThrow('ProjectControl 事实源不一致：control drift');
  });
});
