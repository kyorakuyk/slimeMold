import type { AcceptanceRecord } from '../dev/session';
import { EventStreamRepository } from '../domain/eventStore';
import type { SideEffectRecord } from '../domain/contracts';
import { loadWorkerSideEffects } from './workerEvidence';

export type WorkerRunHostInfrastructureModules = {
  createTauriEventStoreAdapter: typeof import('../domain/tauriEventStore')['createTauriEventStoreAdapter'];
  createTauriEvidenceStore: typeof import('../dev/tauri-run')['createTauriEvidenceStore'];
  SideEffectJournalRepository: typeof import('../domain/sideEffects')['SideEffectJournalRepository'];
  createPersistedWorkerAcceptanceVerifier: typeof import('./workerSideEffects')['createPersistedWorkerAcceptanceVerifier'];
  createPersistedWorkerSideEffectRecorder: typeof import('./workerSideEffects')['createPersistedWorkerSideEffectRecorder'];
};

export interface WorkerRunHostInfrastructureInput {
  projectPath: string;
  listAcceptances: () => readonly AcceptanceRecord[];
  assertOperation: () => void;
}

export type WorkerRunHostSideEffects = ReturnType<
  WorkerRunHostInfrastructureModules['createPersistedWorkerSideEffectRecorder']
>;

export interface WorkerRunHostInfrastructure {
  eventRepository: EventStreamRepository;
  sideEffects: WorkerRunHostSideEffects;
  loadSideEffects: () => Promise<SideEffectRecord[]>;
}

export type WorkerRunHostInfrastructureLoader = () => Promise<WorkerRunHostInfrastructureModules>;

const loadDefaultModules: WorkerRunHostInfrastructureLoader = async () => {
  const [
    { createTauriEventStoreAdapter: createAdapter },
    { createTauriEvidenceStore },
    sideEffectsModule,
    workerSideEffectsModule,
  ] = await Promise.all([
    import('../domain/tauriEventStore'),
    import('../dev/tauri-run'),
    import('../domain/sideEffects'),
    import('./workerSideEffects'),
  ]);
  return {
    createTauriEventStoreAdapter: createAdapter,
    createTauriEvidenceStore,
    SideEffectJournalRepository: sideEffectsModule.SideEffectJournalRepository,
    createPersistedWorkerAcceptanceVerifier: workerSideEffectsModule.createPersistedWorkerAcceptanceVerifier,
    createPersistedWorkerSideEffectRecorder: workerSideEffectsModule.createPersistedWorkerSideEffectRecorder,
  };
};

/**
 * Build the host-owned Worker repositories and receipt recorder for one project.
 * Session admission and runtime/coordinator selection stay at the composition root.
 */
export async function createWorkerRunHostInfrastructure(
  input: WorkerRunHostInfrastructureInput,
  loadModules: WorkerRunHostInfrastructureLoader = loadDefaultModules,
): Promise<WorkerRunHostInfrastructure> {
  const modules = await loadModules();
  const sideEffectRepository = new modules.SideEffectJournalRepository(
    modules.createTauriEventStoreAdapter(input.projectPath),
    input.projectPath,
  );
  const evidencePersistence = modules.createTauriEvidenceStore(
    `${input.projectPath}/.slimemold/evidence`,
    `${input.projectPath}-workers`,
    'host',
  );
  const acceptanceVerifier = modules.createPersistedWorkerAcceptanceVerifier({
    load: async () => input.listAcceptances(),
  });
  const sideEffects = modules.createPersistedWorkerSideEffectRecorder(
    sideEffectRepository,
    evidencePersistence,
    undefined,
    acceptanceVerifier,
  );
  input.assertOperation();
  const eventRepository = new EventStreamRepository(
    modules.createTauriEventStoreAdapter(input.projectPath),
    input.projectPath,
  );
  return {
    eventRepository,
    sideEffects,
    loadSideEffects: () => loadWorkerSideEffects(sideEffectRepository),
  };
}
