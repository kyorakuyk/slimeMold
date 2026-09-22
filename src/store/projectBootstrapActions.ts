/**
 * projectBootstrapActions.ts — synchronous project entry actions.
 *
 * New-project/open-project state construction stays pure; this module owns only dirty,
 * ProjectControl and Zustand patch choreography. Async path/save/error handling stays in the facade.
 */
import type { ProjectFile } from '../types/projectFile';
import {
  buildNewProjectState,
  buildOpenProjectState,
  type NewProjectState,
  type OpenProjectState,
} from './workflowLifecycleState';
import {
  emptyProjectControlRuntimeState,
  type ProjectControlRuntimeState,
  type ProjectControlStoreAdapter,
} from './projectControlLifecycle';

export type ProjectBootstrapStatePatch =
  | (Partial<NewProjectState> & Partial<ProjectControlRuntimeState>)
  | (Partial<OpenProjectState> & Partial<ProjectControlRuntimeState>)
  | Partial<OpenProjectState>;

export interface ProjectBootstrapActionDeps {
  getProjectId: () => string | null;
  getDefaultAgentId: () => string | null;
  setState: (patch: ProjectBootstrapStatePatch) => void;
  setDirtySuppressed: (suppressed: boolean) => void;
  finalizeLoaded: () => void;
  projectControlAdapter: ProjectControlStoreAdapter;
}

export interface ProjectBootstrapActions {
  newProject: (name: string) => void;
  openProject: (file: ProjectFile, path?: string) => boolean;
}

export function createProjectBootstrapActions(
  deps: ProjectBootstrapActionDeps,
): ProjectBootstrapActions {
  const newProject = (name: string): void => {
    deps.projectControlAdapter.resetProjectControlLifecycle(deps.getProjectId());
    deps.setDirtySuppressed(true);
    deps.setState({
      ...buildNewProjectState(name),
      ...emptyProjectControlRuntimeState(),
    });
    deps.setDirtySuppressed(false);
  };

  const openProject = (file: ProjectFile, path?: string): boolean => {
    let state: OpenProjectState;
    try {
      state = buildOpenProjectState(file, path ?? file.name, deps.getDefaultAgentId());
    } catch {
      return false;
    }
    deps.setDirtySuppressed(true);
    deps.setState(state);
    deps.finalizeLoaded();
    deps.setState(deps.projectControlAdapter.activateProjectControlRuntime({
      projectId: file.id,
      taskGraphs: state.projectControl.taskGraphs ?? [],
      runs: state.workerRuns,
    }));
    return true;
  };

  return { newProject, openProject };
}
