import { describe, expect, it, vi } from 'vitest';
import { restoreLastProjectSession } from './projectStartup';
import type { ProjectStartupDependencies } from './projectStartup';
import type { ProjectFile } from '../types/projectFile';

function deps(overrides: Partial<ProjectStartupDependencies> = {}): ProjectStartupDependencies {
  return {
    isTauri: true,
    getLastSession: () => ({ path: 'C:/projects/demo', activeId: 'wf-2' }),
    getProjectId: () => null,
    grantProjectAccess: vi.fn(async () => undefined),
    projectExists: vi.fn(async () => true),
    openProjectByPath: vi.fn(async () => ({
      version: 1,
      kind: 'project',
      id: 'project-1',
      name: 'Demo',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workflows: { 'wf-2': {} },
      activeId: 'wf-1',
    }) as unknown as ProjectFile),
    openProject: vi.fn(() => true),
    scanProgramCustomNodes: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('project startup bootstrap', () => {
  it('restores the saved project and requested active workflow through ports', async () => {
    const input = deps();

    await restoreLastProjectSession(input);

    expect(input.grantProjectAccess).toHaveBeenCalledWith('C:/projects/demo');
    expect(input.projectExists).toHaveBeenCalledWith('C:/projects/demo');
    expect(input.openProject).toHaveBeenCalledWith(
      expect.objectContaining({ activeId: 'wf-2' }),
      'C:/projects/demo',
    );
    expect(input.scanProgramCustomNodes).toHaveBeenCalledOnce();
  });

  it('fails closed when the project is missing or a current project appears', async () => {
    const missing = deps({ projectExists: vi.fn(async () => false) });
    await restoreLastProjectSession(missing);
    expect(missing.openProject).not.toHaveBeenCalled();

    const alreadyLoaded = deps({ getProjectId: () => 'existing-project' });
    await restoreLastProjectSession(alreadyLoaded);
    expect(alreadyLoaded.grantProjectAccess).not.toHaveBeenCalled();
    expect(alreadyLoaded.openProject).not.toHaveBeenCalled();
  });
});
