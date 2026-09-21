import { describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../types/projectFile';
import { createProjectSaveAsController } from './projectSaveAsController';

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    isTauri: false,
    getState: () => ({ projectName: 'Project', activeWfId: 'wf-1' }),
    showSaveDirDialog: vi.fn(async () => 'C:/projects/save-as'),
    buildProjectFile: vi.fn(() => ({ id: 'project-1' }) as ProjectFile),
    saveProjectFile: vi.fn(async () => 'C:/projects/save-as'),
    getPendingProjectEventCount: vi.fn(() => 0),
    flushPendingProjectEvents: vi.fn(async () => {}),
    prepareForSave: vi.fn(async () => {}),
    onSaved: vi.fn(),
    addLog: vi.fn(),
    ...overrides,
  };
}

describe('project save as controller', () => {
  it('rejects non-Tauri Save As without opening a dialog or writing', async () => {
    const deps = createDeps();
    const controller = createProjectSaveAsController(deps);

    await expect(controller.saveProjectAs()).resolves.toBeNull();

    expect(deps.addLog).toHaveBeenCalledWith('warn', '「将项目另存为」需要桌面端（Tauri）环境');
    expect(deps.showSaveDirDialog).not.toHaveBeenCalled();
    expect(deps.buildProjectFile).not.toHaveBeenCalled();
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
    expect(deps.onSaved).not.toHaveBeenCalled();
  });

  it('returns null without writing when the directory picker is cancelled', async () => {
    const deps = createDeps({
      isTauri: true,
      showSaveDirDialog: vi.fn(async () => null),
    });
    const controller = createProjectSaveAsController(deps);

    await expect(controller.saveProjectAs()).resolves.toBeNull();

    expect(deps.buildProjectFile).not.toHaveBeenCalled();
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
    expect(deps.onSaved).not.toHaveBeenCalled();
  });

  it('flushes pending events and reports the saved root', async () => {
    const deps = createDeps({
      isTauri: true,
      getPendingProjectEventCount: vi.fn(() => 1),
    });
    const controller = createProjectSaveAsController(deps);

    await expect(controller.saveProjectAs()).resolves.toBe('C:/projects/save-as');

    expect(deps.prepareForSave).toHaveBeenCalledOnce();
    expect(deps.saveProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-1' }),
      'C:/projects/save-as',
    );
    expect(deps.flushPendingProjectEvents).toHaveBeenCalledWith('project-1', 'C:/projects/save-as');
    expect(deps.onSaved).toHaveBeenCalledWith('C:/projects/save-as', 'wf-1');
  });

  it('blocks Save As when shared save preparation fails', async () => {
    const deps = createDeps({
      isTauri: true,
      prepareForSave: vi.fn(async () => { throw new Error('event stream repair required'); }),
    });
    const controller = createProjectSaveAsController(deps);

    await expect(controller.saveProjectAs()).resolves.toBeNull();

    expect(deps.buildProjectFile).not.toHaveBeenCalled();
    expect(deps.saveProjectFile).not.toHaveBeenCalled();
    expect(deps.addLog).toHaveBeenCalledWith('warn', '项目另存为失败：event stream repair required');
  });

  it('logs a persistence failure and does not report a saved project', async () => {
    const deps = createDeps({
      isTauri: true,
      saveProjectFile: vi.fn(async () => { throw new Error('write failed'); }),
    });
    const controller = createProjectSaveAsController(deps);

    await expect(controller.saveProjectAs()).resolves.toBeNull();

    expect(deps.addLog).toHaveBeenCalledWith('warn', '项目另存为失败：write failed');
    expect(deps.onSaved).not.toHaveBeenCalled();
  });
});
