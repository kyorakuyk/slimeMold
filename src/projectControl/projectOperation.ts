export interface ProjectOperation {
  projectId: string | null;
  projectPath: string | null;
  controller: AbortController;
}

export interface ProjectOperationState {
  projectId: string | null;
  projectPath: string | null;
}

export interface ProjectOperationGuard {
  get: (projectId: string | null, projectPath: string | null) => ProjectOperation;
  assert: (operation: ProjectOperation) => void;
  clear: () => void;
}

export function createProjectOperationGuard(
  getState: () => ProjectOperationState,
): ProjectOperationGuard {
  let current: ProjectOperation | null = null;

  const get = (projectId: string | null, projectPath: string | null): ProjectOperation => {
    if (
      current
      && current.projectId === projectId
      && current.projectPath === projectPath
      && !current.controller.signal.aborted
    ) {
      return current;
    }
    current?.controller.abort();
    current = { projectId, projectPath, controller: new AbortController() };
    return current;
  };

  const assert = (operation: ProjectOperation): void => {
    if (operation.controller.signal.aborted) {
      const error = new Error('项目 operation 已取消');
      error.name = 'AbortError';
      throw error;
    }
    const state = getState();
    if (state.projectId !== operation.projectId || state.projectPath !== operation.projectPath) {
      operation.controller.abort();
      throw new Error('项目在异步 operation 期间发生切换');
    }
  };

  const clear = (): void => {
    current?.controller.abort();
    current = null;
  };

  return { get, assert, clear };
}
