import { parseProjectControlSnapshot } from '../projectControl/persistence';
import {
  clearProjectEventBuffer,
} from '../projectControl/eventBuffer';
import {
  clearWorkerRunRuntime,
  installWorkerRunRuntime,
} from '../projectControl/workerRunRuntime';
import type { ProjectControlSnapshot, ProjectTaskGraph } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';

export interface ProjectControlRuntimeState {
  workerRunRecoveries: WorkerRunRecovery[];
  workerRunEvidence: EvidenceRecord[];
  workerRunSideEffects: SideEffectRecord[];
  workerCleanupProposals: WorkerCleanupProposal[];
}

export interface ProjectControlRuntimeInput {
  projectId: string;
  taskGraphs: readonly ProjectTaskGraph[];
  runs: WorkerRunQueueState[];
}

export interface ProjectControlStoreAdapterDeps {
  clearPendingProjectEvents: (projectId: string) => void;
  clearWorkerRunRuntime: () => void;
  installWorkerRunRuntime: (input: ProjectControlRuntimeInput) => {
    recoveries: WorkerRunRecovery[];
  };
}

export interface ProjectControlStoreAdapter {
  resetProjectControlLifecycle: (projectId?: string | null) => void;
  activateProjectControlRuntime: (input: ProjectControlRuntimeInput) => ProjectControlRuntimeState;
}

export function createProjectControlStoreAdapter(
  deps: ProjectControlStoreAdapterDeps,
): ProjectControlStoreAdapter {
  return {
    resetProjectControlLifecycle(projectId) {
      if (projectId) deps.clearPendingProjectEvents(projectId);
      deps.clearWorkerRunRuntime();
    },
    activateProjectControlRuntime(input) {
      deps.clearPendingProjectEvents(input.projectId);
      const runtime = deps.installWorkerRunRuntime(input);
      return {
        ...emptyProjectControlRuntimeState(),
        workerRunRecoveries: runtime.recoveries,
      };
    },
  };
}

const defaultProjectControlStoreAdapter = createProjectControlStoreAdapter({
  clearPendingProjectEvents: clearProjectEventBuffer,
  clearWorkerRunRuntime,
  installWorkerRunRuntime: (input) => installWorkerRunRuntime(input),
});

export function emptyProjectControlRuntimeState(): ProjectControlRuntimeState {
  return {
    workerRunRecoveries: [],
    workerRunEvidence: [],
    workerRunSideEffects: [],
    workerCleanupProposals: [],
  };
}

export function normalizeProjectControlSnapshot(
  snapshot: ProjectControlSnapshot | undefined,
): ProjectControlSnapshot {
  return parseProjectControlSnapshot(snapshot);
}

export function resetProjectControlLifecycle(projectId?: string | null): void {
  defaultProjectControlStoreAdapter.resetProjectControlLifecycle(projectId);
}

export function installProjectControlRuntime(input: ProjectControlRuntimeInput): ProjectControlRuntimeState {
  const runtime = installWorkerRunRuntime(input);
  return {
    ...emptyProjectControlRuntimeState(),
    workerRunRecoveries: runtime.recoveries,
  };
}

export function activateProjectControlRuntime(input: ProjectControlRuntimeInput): ProjectControlRuntimeState {
  return defaultProjectControlStoreAdapter.activateProjectControlRuntime(input);
}