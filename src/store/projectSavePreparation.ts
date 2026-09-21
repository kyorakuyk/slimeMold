import { EventStreamRepository, type ParsedEventStream } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types/orchestration';
import type { ProjectTaskGraph } from '../projectControl/types';
import {
  projectWorkerRunsOntoOrchestrations,
} from '../projectControl/workerRunOrchestrationProjection';
import {
  restoreMissingWorkerRunsFromEvents,
} from '../projectControl/workerRunRehydration';
import type { ProjectSaveGuard } from './workflowStoreTypes';
import {
  assertProjectSaveGuard,
  type ProjectSaveState,
} from './projectSaveController';

export interface ProjectSavePreparationState extends ProjectSaveState {
  workerRuns: readonly WorkerRunQueueState[];
  orchestrations: readonly Orchestration[];
  projectControl: {
    taskGraphs?: readonly ProjectTaskGraph[];
  };
}

export interface ProjectSavePreparationDeps<State extends ProjectSavePreparationState> {
  isTauri: boolean;
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  readEventStream?: (projectPath: string) => Promise<ParsedEventStream>;
}

export interface ProjectSavePreparation {
  prepareForSave: (guard?: ProjectSaveGuard) => Promise<void>;
}

async function readTauriEventStream(projectPath: string): Promise<ParsedEventStream> {
  const { createTauriEventStoreAdapter } = await import('../domain/tauriEventStore');
  const repository = new EventStreamRepository(
    createTauriEventStoreAdapter(projectPath),
    projectPath,
  );
  return repository.readStream();
}

export function createProjectSavePreparation<State extends ProjectSavePreparationState>(
  deps: ProjectSavePreparationDeps<State>,
): ProjectSavePreparation {
  const readEventStream = deps.readEventStream ?? readTauriEventStream;
  return {
    prepareForSave: async (guard) => {
      let state = deps.getState();
      assertProjectSaveGuard(state, guard);
      if (!deps.isTauri || !state.projectId || !state.projectPath || state.workerRuns.length > 0) return;

      const projectId = state.projectId;
      const projectPath = state.projectPath;
      const parsed = await readEventStream(projectPath);
      assertProjectSaveGuard(deps.getState(), guard);
      if (parsed.status === 'needs-repair') {
        throw new Error(
          `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
        );
      }
      const restored = restoreMissingWorkerRunsFromEvents({
        projectId,
        events: parsed.events,
        taskGraphs: state.projectControl.taskGraphs ?? [],
        existingRuns: state.workerRuns,
      });
      if (restored.issues.length > 0) {
        throw new Error(`Worker Run 投影恢复被阻止：${restored.issues.map((item) => item.message).join('；')}`);
      }
      if (restored.restored) {
        deps.setState({
          workerRuns: restored.runs,
          orchestrations: projectWorkerRunsOntoOrchestrations(state.orchestrations, restored.runs),
        } as unknown as Partial<State>);
        state = deps.getState();
      }
      assertProjectSaveGuard(state, guard);
    },
  };
}
