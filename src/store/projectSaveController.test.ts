import { describe, expect, it, vi } from 'vitest';
import { createProjectSaveQueue } from './projectSaveQueue';
import { createProjectSaveController, type ProjectSaveState } from './projectSaveController';

interface TestState extends ProjectSaveState {
  value: number;
}

function createDeps(overrides: Record<string, unknown> = {}) {
  let state: TestState = {
    projectId: 'project-1',
    projectPath: 'C:/project',
    projectCreatedAt: '2026-09-01T00:00:00.000Z',
    projectDirty: true,
    lastSavedSnapshot: 'old',
    value: 2,
  };
  const setState = vi.fn((patch: Partial<TestState>) => {
    state = { ...state, ...patch };
  });
  const deps = {
    getState: () => state,
    setState,
    enqueue: createProjectSaveQueue().enqueue,
    buildProjectFile: vi.fn(() => ({
      id: 'project-1',
      createdAt: state.projectCreatedAt,
    }) as never),
    saveProjectFile: vi.fn(async (_file: unknown, targetPath?: string) => targetPath ?? 'C:/project'),
    getPendingProjectEventCount: vi.fn(() => 0),
    flushPendingProjectEvents: vi.fn(async () => {}),
    snapshot: (next: TestState) => `${next.projectId}:${next.projectPath}:${next.value}`,
    prepareForSave: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps, getState: () => state };
}

describe('project save controller', () => {
  it('persists the current project and updates the stable saved baseline', async () => {
    const { deps, getState } = createDeps();
    const controller = createProjectSaveController<TestState>(deps);

    await expect(controller.saveProject()).resolves.toBe('C:/project');

    expect(deps.buildProjectFile).toHaveBeenCalledTimes(1);
    expect(deps.saveProjectFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1' }), 'C:/project');
    expect(deps.prepareForSave).toHaveBeenCalledTimes(1);
    expect(getState()).toMatchObject({
      projectId: 'project-1',
      projectPath: 'C:/project',
      projectDirty: false,
      lastSavedSnapshot: 'project-1:C:/project:2',
    });
  });

  it('fails closed when the project changes during preparation', async () => {
    const { deps } = createDeps();
    deps.prepareForSave = vi.fn(async () => {
      deps.setState({ projectPath: 'C:/other-project' });
    });
    const controller = createProjectSaveController<TestState>(deps);

    await expect(controller.saveProject({
      projectId: 'project-1',
      projectPath: 'C:/project',
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.buildProjectFile).not.toHaveBeenCalled();
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
  });

  it('fails closed for an aborted save guard before writing', async () => {
    const { deps } = createDeps();
    const controller = createProjectSaveController<TestState>(deps);
    const abort = new AbortController();
    abort.abort();

    await expect(controller.saveProject({
      projectId: 'project-1',
      projectPath: 'C:/project',
      signal: abort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.buildProjectFile).not.toHaveBeenCalled();
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
  });
});
