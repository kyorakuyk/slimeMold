import type { EvidenceRecord } from '../dev/evidence';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { AgentRouteTable } from '../types/dispatch';
import type { Orchestration, PipelineDef, ProjectArtifacts } from '../types/orchestration';

/** Project, orchestration, and Worker-derived fields owned by the projection boundary. */
export interface WorkflowProjectionState {
  artifacts: ProjectArtifacts;
  agentRouteTable: AgentRouteTable;
  pipelines: PipelineDef[];
  orchestrations: Orchestration[];
  workerRuns: WorkerRunQueueState[];
  workerRunRecoveries: WorkerRunRecovery[];
  workerRunEvidence: EvidenceRecord[];
  workerRunSideEffects: SideEffectRecord[];
  workerCleanupProposals: WorkerCleanupProposal[];
  projectControl: ProjectControlSnapshot;
}
