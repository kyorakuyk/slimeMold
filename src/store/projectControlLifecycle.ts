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
  if (projectId) clearProjectEventBuffer(projectId);
  clearWorkerRunRuntime();
}

export function installProjectControlRuntime(input: {
  projectId: string;
  taskGraphs: readonly ProjectTaskGraph[];
  runs: WorkerRunQueueState[];
}): ProjectControlRuntimeState {
  const runtime = installWorkerRunRuntime(input);
  return {
    ...emptyProjectControlRuntimeState(),
    workerRunRecoveries: runtime.recoveries,
  };
}
