import type { AcceptanceRecord } from '../dev/session';
import type { EventStreamRepository } from '../domain/eventStore';
import type { SideEffectRecord } from '../domain/contracts';
import {
  createWorkerHostRepositoryBundle,
  type WorkerHostRepositoryLoader,
  type WorkerHostRepositoryModules,
  type WorkerHostSideEffects,
} from './workerHostRepositoryBundle';

export type WorkerRunHostInfrastructureModules = WorkerHostRepositoryModules;
export type WorkerRunHostInfrastructureLoader = WorkerHostRepositoryLoader;
export type WorkerRunHostSideEffects = WorkerHostSideEffects;

export interface WorkerRunHostInfrastructureInput {
  projectPath: string;
  listAcceptances: () => readonly AcceptanceRecord[];
  assertOperation: () => void;
}

export interface WorkerRunHostInfrastructure {
  eventRepository: EventStreamRepository;
  sideEffects: WorkerRunHostSideEffects;
  loadSideEffects: () => Promise<SideEffectRecord[]>;
}

/**
 * Active queued-run adapter: add the EventStream repository and preserve its
 * operation fence after the shared host bundle is constructed.
 */
export async function createWorkerRunHostInfrastructure(
  input: WorkerRunHostInfrastructureInput,
  loadModules?: WorkerRunHostInfrastructureLoader,
): Promise<WorkerRunHostInfrastructure> {
  const bundle = await createWorkerHostRepositoryBundle({
    projectPath: input.projectPath,
    listAcceptances: input.listAcceptances,
  }, loadModules);
  input.assertOperation();
  return {
    eventRepository: bundle.createEventRepository(),
    sideEffects: bundle.sideEffects,
    loadSideEffects: bundle.loadSideEffects,
  };
}
