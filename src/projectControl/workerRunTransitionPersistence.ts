import type { EvidenceRecord } from '../dev/evidence';
import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types';
import { projectWorkerRunTransition } from './workerRunTransitionProjection';

export type WorkerTransitionProjectState = Parameters<
  typeof import('../store/workflowSerialize')['buildProjectFile']
>[0];
export type WorkerTransitionProjectFile = ReturnType<
  typeof import('../store/workflowSerialize')['buildProjectFile']
>;
export type WorkerTransitionEventRepository = Parameters<
  typeof import('./eventBuffer')['flushPendingProjectEvents']
>[1];

export interface WorkerRunTransitionInput {
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

export interface WorkerRunTransitionLiveState {
  workerRuns: readonly WorkerRunQueueState[];
  orchestrations: readonly Orchestration[];
  workerRunEvidence: readonly EvidenceRecord[];
  workerRunSideEffects: readonly SideEffectRecord[];
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  setOrchestrations: (orchestrations: Orchestration[]) => void;
  setWorkerRunEvidence: (records: EvidenceRecord[]) => void;
  setWorkerRunSideEffects: (records: SideEffectRecord[]) => void;
  saveProject: (guard: {
    projectId: string;
    projectPath: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
}

export interface WorkerRunTransitionPersistenceDeps {
  projectId: string;
  projectPath: string;
  signal: AbortSignal;
  beforeSave: WorkerTransitionProjectState;
  getState: () => WorkerRunTransitionLiveState;
  assertOperation: () => void;
  recordProjectEvents: (projectId: string, events: readonly DomainEvent[]) => void;
  flushPendingProjectEvents: (
    projectId: string,
    eventRepository: WorkerTransitionEventRepository,
  ) => Promise<unknown>;
  eventRepository: WorkerTransitionEventRepository;
  saveProjectFile: (
    file: WorkerTransitionProjectFile,
    projectPath: string,
  ) => Promise<unknown>;
  buildProjectFile: (state: WorkerTransitionProjectState) => WorkerTransitionProjectFile;
  loadSideEffects: () => Promise<readonly SideEffectRecord[]>;
  collectorEvidence: () => readonly EvidenceRecord[];
  mergeWorkerEvidence: (
    current: readonly EvidenceRecord[],
    incoming: readonly EvidenceRecord[],
  ) => EvidenceRecord[];
  mergeWorkerSideEffects: (
    current: readonly SideEffectRecord[],
    incoming: readonly SideEffectRecord[],
  ) => SideEffectRecord[];
}

const terminalTaskEvents = new Set(['TaskSucceeded', 'TaskFailed', 'TaskBlocked']);
const safeFinalizationEvents = new Set([
  'RunCreated',
  'TaskQueued',
  'RunStarted',
  'TaskStarted',
  'TaskSucceeded',
  'TaskFailed',
  'TaskBlocked',
  'RunSucceeded',
  'RunFailed',
  'RunCancelled',
  'RunBlocked',
]);

function isTerminalFinalization(events: readonly DomainEvent[]): boolean {
  return events.some((event) => terminalTaskEvents.has(event.eventType))
    && events.every((event) => safeFinalizationEvents.has(event.eventType));
}

/**
 * Application choreography for one queued Worker transition.
 *
 * Event buffering, durable evidence/side-effect stores, ProjectFile serialization and
 * the Zustand facade remain injected fact owners; this controller preserves their
 * existing ordering and the receipt-after-cancellation raw-save exception.
 */
export function createWorkerRunTransitionPersistence(
  deps: WorkerRunTransitionPersistenceDeps,
): (transition: WorkerRunTransitionInput) => Promise<void> {
  return async ({ state, events }) => {
    if (deps.signal.aborted && isTerminalFinalization(events)) {
      deps.recordProjectEvents(deps.projectId, events);
      await deps.flushPendingProjectEvents(deps.projectId, deps.eventRepository);
      const oldRuns = (deps.beforeSave.workerRuns ?? []).map((run) => (
        run.runId === state.runId ? state : run
      ));
      await deps.saveProjectFile(
        deps.buildProjectFile({ ...deps.beforeSave, workerRuns: oldRuns }),
        deps.projectPath,
      );
      return;
    }

    deps.assertOperation();
    const latest = deps.getState();
    deps.assertOperation();
    deps.recordProjectEvents(deps.projectId, events);
    const { nextWorkerRuns, nextOrchestrations } = projectWorkerRunTransition({
      currentWorkerRuns: latest.workerRuns,
      currentOrchestrations: latest.orchestrations,
      transition: state,
    });
    latest.setWorkerRuns(nextWorkerRuns);
    latest.setOrchestrations(nextOrchestrations);
    latest.setWorkerRunEvidence(
      deps.mergeWorkerEvidence(latest.workerRunEvidence, deps.collectorEvidence()),
    );
    const effectRecords = await deps.loadSideEffects();
    deps.assertOperation();
    latest.setWorkerRunSideEffects(
      deps.mergeWorkerSideEffects(latest.workerRunSideEffects, effectRecords),
    );
    await latest.saveProject({
      projectId: deps.projectId,
      projectPath: deps.projectPath,
      signal: deps.signal,
    });
    deps.assertOperation();
  };
}
