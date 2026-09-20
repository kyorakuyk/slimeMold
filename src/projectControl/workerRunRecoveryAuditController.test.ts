import { describe, expect, it, vi } from 'vitest';
import type { ParsedEventStream } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectControlSnapshot } from './types';
import {
  createWorkerRunRecoveryAuditController,
  type WorkerRunRecoveryAuditDeps,
  type WorkerRunRecoveryAuditState,
} from './workerRunRecoveryAuditController';

const stream = (status: 'ok' | 'needs-repair'): ParsedEventStream => ({
  status,
  events: [],
  lastSequence: 0,
} as unknown as ParsedEventStream);

const run = (runId: string): WorkerRunQueueState => ({
  runId,
  projectId: 'project-1',
  status: 'running',
  tasks: {},
  updatedAt: '2026-09-21T00:00:00.000Z',
} as unknown as WorkerRunQueueState);

function makeDeps(overrides: Partial<WorkerRunRecoveryAuditDeps> = {}) {
  const state: WorkerRunRecoveryAuditState = {
    projectId: 'project-1',
    projectPath: 'C:/project',
    projectControl: {} as ProjectControlSnapshot,
    workerRuns: [],
    orchestrations: [],
    workerRunEvidence: [],
    workerRunSideEffects: [],
  };
  const baseline = vi.fn(async () => ({ migrated: false, stream: stream('ok') }));
  const auditWorker = vi.fn(() => ({
    ok: true,
    projection: { lastSequence: 0, runs: {}, tasks: {}, taskExecutions: {}, attempts: {} },
    issues: [],
  }));
  const auditControl = vi.fn(() => ({ ok: true, issues: [] }));
  const installRuntime = vi.fn(() => ({ recoveries: [] }));
  const deps: WorkerRunRecoveryAuditDeps = {
    isTauri: true,
    getState: () => state,
    setWorkerRuns: vi.fn(),
    setOrchestrations: vi.fn(),
    setWorkerRunRecoveries: vi.fn(),
    setWorkerCleanupProposals: vi.fn(),
    addLog: vi.fn(),
    saveProject: vi.fn(async () => 'saved'),
    createEventRepository: vi.fn(async () => ({ readStream: vi.fn() } as never)),
    ensureEventBaseline: baseline as unknown as WorkerRunRecoveryAuditDeps['ensureEventBaseline'],
    reconcileWorkerRunsFromEvents: vi.fn(() => ({ runs: [], changedRunIds: [], issues: [] })) as unknown as WorkerRunRecoveryAuditDeps['reconcileWorkerRunsFromEvents'],
    rehydrateWorkerRunsFromEvents: vi.fn(() => ({ runs: [], issues: [] })) as unknown as WorkerRunRecoveryAuditDeps['rehydrateWorkerRunsFromEvents'],
    auditWorkerRunConsistency: auditWorker as unknown as WorkerRunRecoveryAuditDeps['auditWorkerRunConsistency'],
    auditProjectControlConsistency: auditControl as unknown as WorkerRunRecoveryAuditDeps['auditProjectControlConsistency'],
    installWorkerRunRuntime: installRuntime as unknown as WorkerRunRecoveryAuditDeps['installWorkerRunRuntime'],
    projectWorkerRunsOntoOrchestrations: vi.fn((orchestrations) => [...orchestrations]),
    suppressInvalidWorkerRunProjection: vi.fn((orchestrations) => [...orchestrations]),
    now: () => '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
  return { deps, state, baseline, auditWorker, auditControl, installRuntime };
}

describe('createWorkerRunRecoveryAuditController', () => {
  it('audits the healthy stream and installs the derived runtime recovery projection', async () => {
    const fixture = makeDeps();
    const controller = createWorkerRunRecoveryAuditController(fixture.deps);

    await controller.auditLoadedWorkerRunFacts('C:/project', [], new AbortController().signal);

    expect(fixture.deps.createEventRepository).toHaveBeenCalledWith('C:/project');
    expect(fixture.baseline).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      now: '2026-09-21T00:00:00.000Z',
    }));
    expect(fixture.auditWorker).toHaveBeenCalledTimes(1);
    expect(fixture.auditControl).toHaveBeenCalledTimes(1);
    expect(fixture.installRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.deps.setWorkerRunRecoveries).toHaveBeenCalledWith([]);
  });

  it('reconciles changed retry snapshots before auditing and saving', async () => {
    const fixture = makeDeps();
    const existing = run('run-1');
    const reconciled = run('run-1');
    fixture.state.workerRuns = [existing];
    fixture.deps.reconcileWorkerRunsFromEvents = vi.fn(() => ({
      runs: [reconciled],
      changedRunIds: ['run-1'],
      issues: [],
    })) as unknown as WorkerRunRecoveryAuditDeps['reconcileWorkerRunsFromEvents'];
    const controller = createWorkerRunRecoveryAuditController(fixture.deps);

    await controller.auditLoadedWorkerRunFacts('C:/project', [], new AbortController().signal);

    expect(fixture.deps.setWorkerRuns).toHaveBeenCalledWith([reconciled]);
    expect(fixture.deps.saveProject).toHaveBeenCalledWith(
      'project-1',
      'C:/project',
      expect.any(AbortSignal),
    );
  });

  it('turns a needs-repair stream into recovery projection and suppresses cleanup proposals', async () => {
    const fixture = makeDeps({
      ensureEventBaseline: vi.fn(async () => ({ migrated: false, stream: stream('needs-repair') })) as unknown as WorkerRunRecoveryAuditDeps['ensureEventBaseline'],
    });
    const controller = createWorkerRunRecoveryAuditController(fixture.deps);

    await controller.auditLoadedWorkerRunFacts('C:/project', [], new AbortController().signal);

    expect(fixture.auditWorker).not.toHaveBeenCalled();
    expect(fixture.deps.setWorkerCleanupProposals).toHaveBeenCalledWith([]);
    expect(fixture.deps.addLog).toHaveBeenCalledWith('warn', expect.stringContaining('Worker 事实源审计未通过'));
  });

  it('converts repository failures into event-stream-invalid recovery without swallowing the warning', async () => {
    const failure = new Error('event repository unavailable');
    const fixture = makeDeps({
      createEventRepository: vi.fn(async () => { throw failure; }),
    });
    fixture.state.workerRuns = [run('run-1')];
    const controller = createWorkerRunRecoveryAuditController(fixture.deps);

    await controller.auditLoadedWorkerRunFacts('C:/project', [], new AbortController().signal);

    expect(fixture.deps.setWorkerRunRecoveries).toHaveBeenCalledWith([
      expect.objectContaining({ runId: 'run-1', reason: 'event-stream-invalid' }),
    ]);
    expect(fixture.deps.setWorkerCleanupProposals).toHaveBeenCalledWith([]);
    expect(fixture.deps.addLog).toHaveBeenCalledWith('warn', 'Worker 事件流无法审计：event repository unavailable');
  });
});
