import { persistProjectFile } from './projectFilePersistence';
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
  saveProjectFile: (file: ProjectFile, targetPath?: string) => Promise<string>;
  getPendingProjectEventCount: (projectId: string) => number;
  flushPendingProjectEvents: (projectId: string, projectRoot: string) => Promise<void>;
  prepareForSave?: () => Promise<void>;
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
      try {
        await deps.prepareForSave?.();
      } catch (error) {
        deps.addLog('warn', `项目另存为失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      const preparedState = deps.getState();
      const file = deps.buildProjectFile(preparedState);
      try {
        const root = await persistProjectFile(file, picked, {
          saveProjectFile: deps.saveProjectFile,
          getPendingProjectEventCount: deps.getPendingProjectEventCount,
          flushPendingProjectEvents: deps.flushPendingProjectEvents,
        });
        deps.onSaved(root, preparedState.activeWfId);
        return root;
      } catch (error) {
        deps.addLog('warn', `项目另存为失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}
