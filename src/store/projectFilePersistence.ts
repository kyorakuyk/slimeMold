import type { ProjectFile } from '../types';

export interface ProjectFilePersistencePort {
  saveProjectFile: (file: ProjectFile, targetPath?: string) => Promise<string>;
  getPendingProjectEventCount: (projectId: string) => number;
  flushPendingProjectEvents: (projectId: string, projectRoot: string) => Promise<void>;
}

export async function persistProjectFile(
  file: ProjectFile,
  targetPath: string | undefined,
  port: ProjectFilePersistencePort,
): Promise<string> {
  const projectRoot = await port.saveProjectFile(file, targetPath);
  if (port.getPendingProjectEventCount(file.id) > 0) {
    await port.flushPendingProjectEvents(file.id, projectRoot);
  }
  return projectRoot;
}
