import type { ProjectFile } from '../types/projectFile';

export interface ProjectStartupSession {
  path: string;
  activeId?: string;
}

export interface ProjectStartupDependencies {
  isTauri: boolean;
  getLastSession: () => ProjectStartupSession | null;
  getProjectId: () => string | null;
  grantProjectAccess: (path: string) => Promise<void>;
  projectExists: (path: string) => Promise<boolean>;
  openProjectByPath: (path: string) => Promise<ProjectFile | null>;
  openProject: (file: ProjectFile, path: string) => boolean;
  scanProgramCustomNodes: () => Promise<unknown>;
  isCancelled?: () => boolean;
}

/** Restore the last desktop project without coupling startup sequencing to React. */
export async function restoreLastProjectSession(deps: ProjectStartupDependencies): Promise<void> {
  if (!deps.isTauri) return;
  const session = deps.getLastSession();
  if (!session || deps.getProjectId()) return;
  const isCancelled = deps.isCancelled ?? (() => false);

  try {
    // Scope must be granted before any filesystem access; preserve the original fail-open grant behavior.
    await deps.grantProjectAccess(session.path).catch(() => undefined);
    if (isCancelled() || deps.getProjectId()) return;

    if (!(await deps.projectExists(session.path)) || isCancelled() || deps.getProjectId()) return;
    const file = await deps.openProjectByPath(session.path);
    if (!file || isCancelled() || deps.getProjectId()) return;

    if (session.activeId && file.workflows[session.activeId]) {
      file.activeId = session.activeId;
    }
    deps.openProject(file, session.path);
    void deps.scanProgramCustomNodes().catch(() => undefined);
  } catch {
    // Startup recovery is best effort and must not block the application shell.
  }
}
