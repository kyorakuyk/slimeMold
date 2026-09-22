import type { AcceptanceRecord } from '../dev/session';
import type { EvidenceRecord } from '../dev/evidence';
import { EventStreamRepository } from '../domain/eventStore';
import type { SideEffectRecord } from '../domain/contracts';
import { loadWorkerEvidence, loadWorkerSideEffects } from './workerEvidence';

export type WorkerHostRepositoryModules = {
  createTauriEventStoreAdapter: typeof import('../domain/tauriEventStore')['createTauriEventStoreAdapter'];
  createTauriEvidenceStore: typeof import('../dev/tauri-run')['createTauriEvidenceStore'];
  SideEffectJournalRepository: typeof import('../domain/sideEffects')['SideEffectJournalRepository'];
  createPersistedWorkerAcceptanceVerifier: typeof import('./workerSideEffects')['createPersistedWorkerAcceptanceVerifier'];
  createPersistedWorkerSideEffectRecorder: typeof import('./workerSideEffects')['createPersistedWorkerSideEffectRecorder'];
};

export type WorkerEvidenceRepositoryModules = Pick<
  WorkerHostRepositoryModules,
  'createTauriEventStoreAdapter' | 'createTauriEvidenceStore' | 'SideEffectJournalRepository'
>;

export interface WorkerHostRepositoryBundleInput {
  projectPath: string;
  listAcceptances: () => readonly AcceptanceRecord[];
}

export interface WorkerEvidenceRepositoryBundleInput {
  projectPath: string;
}

export type WorkerHostSideEffects = ReturnType<
  WorkerHostRepositoryModules['createPersistedWorkerSideEffectRecorder']
>;

export type WorkerHostRepositoryLoader = () => Promise<WorkerHostRepositoryModules>;
export type WorkerEvidenceRepositoryLoader = () => Promise<WorkerEvidenceRepositoryModules>;

export interface WorkerHostRepositoryBundle {
  sideEffects: WorkerHostSideEffects;
  loadEvidence: () => Promise<EvidenceRecord[]>;
  loadSideEffects: () => Promise<SideEffectRecord[]>;
  createEventRepository: () => EventStreamRepository;
}

export interface WorkerEvidenceRepositoryBundle {
  loadEvidence: () => Promise<EvidenceRecord[]>;
  loadSideEffects: () => Promise<SideEffectRecord[]>;
}

export const loadWorkerHostRepositoryModules: WorkerHostRepositoryLoader = async () => {
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

export const loadWorkerEvidenceRepositoryModules: WorkerEvidenceRepositoryLoader = async () => {
  const [
    { createTauriEvidenceStore },
    { createTauriEventStoreAdapter: createAdapter },
    sideEffectsModule,
  ] = await Promise.all([
    import('../dev/tauri-run'),
    import('../domain/tauriEventStore'),
    import('../domain/sideEffects'),
  ]);
  return {
    createTauriEventStoreAdapter: createAdapter,
    createTauriEvidenceStore,
    SideEffectJournalRepository: sideEffectsModule.SideEffectJournalRepository,
  };
};

function createEvidenceRepositoryBundleFromModules(
  input: WorkerEvidenceRepositoryBundleInput,
  modules: WorkerEvidenceRepositoryModules,
): WorkerEvidenceRepositoryBundle {
  const evidencePersistence = modules.createTauriEvidenceStore(
    `${input.projectPath}/.slimemold/evidence`,
    `${input.projectPath}-workers`,
    'host',
  );
  const sideEffectRepository = new modules.SideEffectJournalRepository(
    modules.createTauriEventStoreAdapter(input.projectPath),
    input.projectPath,
  );
  return {
    loadEvidence: () => loadWorkerEvidence(evidencePersistence),
    loadSideEffects: () => loadWorkerSideEffects(sideEffectRepository),
  };
}

export async function createWorkerEvidenceRepositoryBundle(
  input: WorkerEvidenceRepositoryBundleInput,
  loadModules: WorkerEvidenceRepositoryLoader = loadWorkerEvidenceRepositoryModules,
): Promise<WorkerEvidenceRepositoryBundle> {
  return createEvidenceRepositoryBundleFromModules(input, await loadModules());
}

export function createWorkerEvidenceRepositoryBundleFromModules(
  input: WorkerEvidenceRepositoryBundleInput,
  modules: WorkerEvidenceRepositoryModules,
): WorkerEvidenceRepositoryBundle {
  return createEvidenceRepositoryBundleFromModules(input, modules);
}

/** Shared full host repository construction; lifecycle and recovery policy stay outside. */
export function createWorkerHostRepositoryBundleFromModules(
  input: WorkerHostRepositoryBundleInput,
  modules: WorkerHostRepositoryModules,
): WorkerHostRepositoryBundle {
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
  return {
    sideEffects,
    loadEvidence: () => loadWorkerEvidence(evidencePersistence),
    loadSideEffects: () => loadWorkerSideEffects(sideEffectRepository),
    createEventRepository: () => new EventStreamRepository(
      modules.createTauriEventStoreAdapter(input.projectPath),
      input.projectPath,
    ),
  };
}

export async function createWorkerHostRepositoryBundle(
  input: WorkerHostRepositoryBundleInput,
  loadModules: WorkerHostRepositoryLoader = loadWorkerHostRepositoryModules,
): Promise<WorkerHostRepositoryBundle> {
  return createWorkerHostRepositoryBundleFromModules(input, await loadModules());
}
