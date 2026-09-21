import type { ProjectFile } from '../types';
import type { ProjectSaveGuard } from './workflowStoreTypes';
import { persistProjectFile } from './projectFilePersistence';

export interface ProjectSaveState {
  projectId: string | null;
  projectPath: string | null;
  projectCreatedAt: string | null;
  projectDirty: boolean;
  lastSavedSnapshot: string | null;
}

export interface ProjectSaveControllerDeps<State extends ProjectSaveState> {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  enqueue: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  buildProjectFile: (state: State) => ProjectFile;
  saveProjectFile: (file: ProjectFile, targetPath?: string) => Promise<string>;
  getPendingProjectEventCount: (projectId: string) => number;
  flushPendingProjectEvents: (projectId: string, projectRoot: string) => Promise<void>;
  snapshot: (state: State) => string;
  prepareForSave?: (guard?: ProjectSaveGuard) => Promise<void>;
}

export interface ProjectSaveController {
  saveProject: (guard?: ProjectSaveGuard) => Promise<string>;
}

export function assertProjectSaveGuard<State extends ProjectSaveState>(
  state: State,
  guard?: ProjectSaveGuard,
): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    const error = new Error('项目保存 operation 已取消');
    error.name = 'AbortError';
    throw error;
  }
  if (state.projectId !== guard.projectId || state.projectPath !== guard.projectPath) {
    const error = new Error('项目已切换，拒绝提交旧保存 operation');
    error.name = 'AbortError';
    throw error;
  }
}

export function createProjectSaveController<State extends ProjectSaveState>(
  deps: ProjectSaveControllerDeps<State>,
): ProjectSaveController {
  return {
    saveProject: async (guard) => {
      const initial = deps.getState();
      const saveKey = `${initial.projectId ?? 'unsaved'}:${initial.projectPath ?? 'memory'}`;
      return deps.enqueue(saveKey, async () => {
        assertProjectSaveGuard(deps.getState(), guard);
        await deps.prepareForSave?.(guard);

        const state = deps.getState();
        assertProjectSaveGuard(state, guard);
        const file = deps.buildProjectFile(state);
        assertProjectSaveGuard(deps.getState(), guard);
        const projectRoot = await persistProjectFile(file, state.projectPath ?? undefined, {
          saveProjectFile: async (nextFile, targetPath) => {
            const root = await deps.saveProjectFile(nextFile, targetPath);
            assertProjectSaveGuard(deps.getState(), guard);
            return root;
          },
          getPendingProjectEventCount: (projectId) => {
            assertProjectSaveGuard(deps.getState(), guard);
            return deps.getPendingProjectEventCount(projectId);
          },
          flushPendingProjectEvents: async (projectId, root) => {
            assertProjectSaveGuard(deps.getState(), guard);
            await deps.flushPendingProjectEvents(projectId, root);
            assertProjectSaveGuard(deps.getState(), guard);
          },
        });

        assertProjectSaveGuard(deps.getState(), guard);
        deps.setState({
          projectId: file.id,
          projectCreatedAt: file.createdAt,
          projectPath: projectRoot,
          projectDirty: false,
        } as Partial<State>);
        deps.setState({ lastSavedSnapshot: deps.snapshot(deps.getState()) } as Partial<State>);
        return projectRoot;
      });
    },
  };
}
