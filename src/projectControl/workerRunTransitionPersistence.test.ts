import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRecord } from '../dev/evidence';
import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types';
import {
  createWorkerRunTransitionPersistence,
  type WorkerRunTransitionPersistenceDeps,
  type WorkerTransitionProjectFile,
} from './workerRunTransitionPersistence';

const run = (runId: string): WorkerRunQueueState => ({
  runId,
  projectId: 'project-1',
  status: 'running',
  tasks: [],
  updatedAt: `${runId}-updated`,
} as unknown as WorkerRunQueueState);

const event = (eventType: string): DomainEvent => ({
  eventType,
  eventId: `${eventType}-event`,
  aggregateId: 'run-1',
  occurredAt: '2026-09-21T00:00:00.000Z',
  payload: {},
} as unknown as DomainEvent);

const evidence = (id: string): EvidenceRecord => ({ id } as EvidenceRecord);
const sideEffect = (idempotencyKey: string): SideEffectRecord => ({ idempotencyKey } as SideEffectRecord);

function makeDeps(overrides: Partial<WorkerRunTransitionPersistenceDeps> = {}) {
  const before = run('before');
  const latest = {
    workerRuns: [before],
    orchestrations: [{ id: 'orchestration-1' } as Orchestration],
    workerRunEvidence: [],
    workerRunSideEffects: [],
    setWorkerRuns: vi.fn(),
    setOrchestrations: vi.fn(),
    setWorkerRunEvidence: vi.fn(),
    setWorkerRunSideEffects: vi.fn(),
    saveProject: vi.fn(async () => 'saved'),
  };
  const deps: WorkerRunTransitionPersistenceDeps = {
    projectId: 'project-1',
    projectPath: 'C:/projects/project-1',
    signal: new AbortController().signal,
    beforeSave: { workerRuns: [before] } as WorkerRunTransitionPersistenceDeps['beforeSave'],
    getState: () => latest,
    assertOperation: vi.fn(),
    recordProjectEvents: vi.fn(),
    flushPendingProjectEvents: vi.fn(async () => ({ count: 1 })),
    eventRepository: {} as WorkerRunTransitionPersistenceDeps['eventRepository'],
    saveProjectFile: vi.fn(async () => 'C:/projects/project-1/project.json'),
    buildProjectFile: vi.fn(() => ({ kind: 'project' } as WorkerTransitionProjectFile)),
    loadSideEffects: vi.fn(async () => [sideEffect('effect-1')]),
    collectorEvidence: () => [evidence('evidence-1')],
    mergeWorkerEvidence: vi.fn((current, incoming) => [...current, ...incoming]),
    mergeWorkerSideEffects: vi.fn((current, incoming) => [...current, ...incoming]),
    projectWorkerRunsOntoOrchestrations: vi.fn((orchestrations) => [...orchestrations]),
    ...overrides,
  };
  return { deps, latest, before };
}

describe('createWorkerRunTransitionPersistence', () => {
  it('persists normal transitions from fresh state and durable side effects', async () => {
    const { deps, latest } = makeDeps();
    const next = run('before');
    const persistTransition = createWorkerRunTransitionPersistence(deps);

    await persistTransition({ state: next, events: [event('TaskStarted')] });

    expect(deps.recordProjectEvents).toHaveBeenCalledWith('project-1', [expect.objectContaining({ eventType: 'TaskStarted' })]);
    expect(latest.setWorkerRuns).toHaveBeenCalledWith([next]);
    expect(latest.setWorkerRunEvidence).toHaveBeenCalledWith([evidence('evidence-1')]);
    expect(latest.setWorkerRunSideEffects).toHaveBeenCalledWith([sideEffect('effect-1')]);
    expect(latest.saveProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      projectPath: 'C:/projects/project-1',
      signal: deps.signal,
    });
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
    expect(deps.flushPendingProjectEvents).not.toHaveBeenCalled();
    expect(deps.assertOperation).toHaveBeenCalledTimes(4);
  });

  it('finalizes a receipt-after-cancellation from beforeSave without live-state mutation', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, latest } = makeDeps({ signal: controller.signal });
    const terminal = run('before');
    const projectFile = { kind: 'project', id: 'project-1' } as WorkerTransitionProjectFile;
    deps.buildProjectFile = vi.fn(() => projectFile);
    const persistTransition = createWorkerRunTransitionPersistence(deps);

    await persistTransition({ state: terminal, events: [event('TaskSucceeded')] });

    expect(deps.recordProjectEvents).toHaveBeenCalledWith('project-1', [expect.objectContaining({ eventType: 'TaskSucceeded' })]);
    expect(deps.flushPendingProjectEvents).toHaveBeenCalledWith('project-1', deps.eventRepository);
    expect(deps.buildProjectFile).toHaveBeenCalledWith({
      ...deps.beforeSave,
      workerRuns: [terminal],
    });
    expect(deps.saveProjectFile).toHaveBeenCalledWith(projectFile, 'C:/projects/project-1');
    expect(deps.assertOperation).not.toHaveBeenCalled();
    expect(latest.setWorkerRuns).not.toHaveBeenCalled();
    expect(latest.saveProject).not.toHaveBeenCalled();
  });

  it('does not use raw finalization for an unsafe cancelled event batch', async () => {
    const controller = new AbortController();
    controller.abort();
    const guardFailure = new Error('operation cancelled');
    const { deps, latest } = makeDeps({
      signal: controller.signal,
      assertOperation: vi.fn(() => { throw guardFailure; }),
    });
    const persistTransition = createWorkerRunTransitionPersistence(deps);

    await expect(persistTransition({ state: run('before'), events: [event('UnknownEvent')] }))
      .rejects.toBe(guardFailure);

    expect(deps.saveProjectFile).not.toHaveBeenCalled();
    expect(deps.flushPendingProjectEvents).not.toHaveBeenCalled();
    expect(latest.saveProject).not.toHaveBeenCalled();
  });


  it('does not silently convert a side-effect load failure into a save', async () => {
    const loadFailure = new Error('side-effect journal unavailable');
    const { deps, latest } = makeDeps({
      loadSideEffects: vi.fn(async () => { throw loadFailure; }),
    });
    const persistTransition = createWorkerRunTransitionPersistence(deps);

    await expect(persistTransition({ state: run('next'), events: [event('TaskStarted')] }))
      .rejects.toBe(loadFailure);

    expect(latest.saveProject).not.toHaveBeenCalled();
  });
});
