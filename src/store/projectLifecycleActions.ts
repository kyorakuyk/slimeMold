/**
 * projectLifecycleActions.ts — injected project-boundary action choreography.
 *
 * Host lifecycle, ProjectControl runtime, dirty tracking and session persistence are supplied
 * as capabilities. The module does not import the Zustand facade or host controllers.
 */
import type { CloseProjectStatePatch } from './workflowLifecycleState';

export interface ProjectLifecycleActionDeps {
  getProjectId: () => string | null;
  resetProjectControlLifecycle: (projectId?: string | null) => void;
  setDirtySuppressed: (suppressed: boolean) => void;
  setState: (patch: CloseProjectStatePatch) => void;
  clearLastSession: () => void;
  buildCloseState: () => CloseProjectStatePatch;
}

export interface ProjectLifecycleActions {
  closeProject: () => void;
}

export function createProjectLifecycleActions(
  deps: ProjectLifecycleActionDeps,
): ProjectLifecycleActions {
  const closeProject = (): void => {
    const currentProjectId = deps.getProjectId();
    deps.resetProjectControlLifecycle(currentProjectId);
    deps.setDirtySuppressed(true);
    deps.setState(deps.buildCloseState());
    deps.setDirtySuppressed(false);
    deps.clearLastSession();
  };

  return { closeProject };
}
