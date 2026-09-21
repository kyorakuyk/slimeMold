import type { EvidenceRecord } from '../dev/evidence';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerCleanupProposal } from '../projectControl/workerCleanup';
import type { WorkerRunRecovery } from '../projectControl/workerRunRuntime';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { AgentRouteTable } from '../types/dispatch';
import type { Orchestration, PipelineDef, ProjectArtifacts } from '../types/orchestration';
import type { Artifact } from '../types/orchestration';

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

export interface WorkflowProjectionPorts<State extends WorkflowProjectionState = WorkflowProjectionState> {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  normalizeProjectControlSnapshot: (snapshot: ProjectControlSnapshot) => ProjectControlSnapshot;
}

export function createWorkflowProjectionCommands<State extends WorkflowProjectionState>(
  ports: WorkflowProjectionPorts<State>,
) {
  const setProjection = (patch: Partial<WorkflowProjectionState>): void => {
    ports.setState(patch as Partial<State>);
  };

  return {
    setArtifact: (stage: string, kind: string, artifact: Artifact): void => {
      const state = ports.getState();
      const stageMap = state.artifacts[stage] ?? {};
      setProjection({
        artifacts: {
          ...state.artifacts,
          [stage]: { ...stageMap, [kind]: artifact },
        },
      });
    },

    setAgentRouteTable: (table: AgentRouteTable): void => {
      setProjection({ agentRouteTable: table });
    },

    setPipelines: (defs: PipelineDef[]): void => {
      setProjection({ pipelines: defs });
    },

    setOrchestrations: (orchestrations: Orchestration[]): void => {
      setProjection({ orchestrations });
    },

    setWorkerRuns: (runs: WorkerRunQueueState[]): void => {
      setProjection({ workerRuns: runs });
    },

    setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]): void => {
      setProjection({ workerRunRecoveries: recoveries });
    },

    setWorkerRunEvidence: (evidence: EvidenceRecord[]): void => {
      setProjection({ workerRunEvidence: evidence });
    },

    setWorkerRunSideEffects: (effects: SideEffectRecord[]): void => {
      setProjection({ workerRunSideEffects: effects });
    },

    setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]): void => {
      setProjection({ workerCleanupProposals: proposals });
    },

    setProjectControl: (snapshot: ProjectControlSnapshot): void => {
      setProjection({ projectControl: ports.normalizeProjectControlSnapshot(snapshot) });
    },

    upsertPipeline: (definition: PipelineDef): void => {
      const state = ports.getState();
      const exists = state.pipelines.some((pipeline) => pipeline.id === definition.id);
      setProjection({
        pipelines: exists
          ? state.pipelines.map((pipeline) => (pipeline.id === definition.id ? definition : pipeline))
          : [...state.pipelines, definition],
      });
    },
  };
}
