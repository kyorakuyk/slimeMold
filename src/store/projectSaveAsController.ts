import type { ProjectFile } from '../types';

export interface ProjectSaveAsState {
  projectName: string | null;
  activeWfId: string;
}

export interface ProjectSaveAsControllerDeps<State extends ProjectSaveAsState> {
  isTauri: boolean;
  getState: () => State;
  showSaveDirDialog: (name: string) => Promise<string | null>;
  buildProjectFile: (state: State) => ProjectFile;
  saveProjectFile: (file: ProjectFile, targetPath: string) => Promise<string>;
  getPendingProjectEventCount: (projectId: string) => number;
  flushPendingProjectEvents: (projectId: string, projectRoot: string) => Promise<void>;
  onSaved: (projectRoot: string, activeWfId: string) => void;
  addLog: (level: 'warn', message: string) => void;
}

export interface ProjectSaveAsController {
  saveProjectAs: () => Promise<string | null>;
}

export function createProjectSaveAsController<State extends ProjectSaveAsState>(
  deps: ProjectSaveAsControllerDeps<State>,
): ProjectSaveAsController {
  return {
    saveProjectAs: async () => {
      const state = deps.getState();
      if (!deps.isTauri) {
        deps.addLog('warn', '「将项目另存为」需要桌面端（Tauri）环境');
        return null;
      }
      const picked = await deps.showSaveDirDialog(state.projectName ?? '未命名项目');
      if (!picked) return null;
      const file = deps.buildProjectFile(state);
      try {
        const root = await deps.saveProjectFile(file, picked);
        if (deps.getPendingProjectEventCount(file.id) > 0) {
          await deps.flushPendingProjectEvents(file.id, root);
        }
        deps.onSaved(root, state.activeWfId);
        return root;
      } catch (error) {
        deps.addLog('warn', `项目另存为失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}
