import type { ProjectFile } from '../types/projectFile';

export type BeforeProjectFileSideEffect = () => void;

export interface ProjectFilePersistencePort {
  saveProjectFile: (
    file: ProjectFile,
    targetPath?: string,
    beforeWrite?: BeforeProjectFileSideEffect,
  ) => Promise<string>;
  getPendingProjectEventCount: (projectId: string) => number;
  flushPendingProjectEvents: (
    projectId: string,
    projectRoot: string,
    beforeFlush?: BeforeProjectFileSideEffect,
  ) => Promise<void>;
}

export interface ProjectFilePersistenceOptions {
  beforeWrite?: BeforeProjectFileSideEffect;
  beforeFlush?: BeforeProjectFileSideEffect;
}

export async function persistProjectFile(
  file: ProjectFile,
  targetPath: string | undefined,
  port: ProjectFilePersistencePort,
  options: ProjectFilePersistenceOptions = {},
): Promise<string> {
  const projectRoot = options.beforeWrite
    ? await port.saveProjectFile(file, targetPath, options.beforeWrite)
    : await port.saveProjectFile(file, targetPath);
  if (port.getPendingProjectEventCount(file.id) > 0) {
    if (options.beforeFlush) {
      await port.flushPendingProjectEvents(file.id, projectRoot, options.beforeFlush);
    } else {
      await port.flushPendingProjectEvents(file.id, projectRoot);
    }
  }
  return projectRoot;
}
