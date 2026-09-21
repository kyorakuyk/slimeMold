import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform/env', async () => {
  const actual = await vi.importActual<typeof import('../platform/env')>('../platform/env');
  return {
    ...actual,
    isTauri: true,
    showSaveDirDialog: vi.fn(async () => 'C:/projects/save-as'),
  };
});

vi.mock('../io/projectIO', async () => {
  const actual = await vi.importActual<typeof import('../io/projectIO')>('../io/projectIO');
  return {
    ...actual,
    saveProjectFile: vi.fn(async () => 'C:/projects/save-as'),
    saveLastSession: vi.fn(),
  };
});

vi.mock('./projectSavePreparation', () => ({
  createProjectSavePreparation: () => ({ prepareForSave: vi.fn(async () => {}) }),
}));

import { useWorkflowStore } from './workflowStore';
import { projectSnapshot } from './workflowSerialize';

describe('workflowStore Save As dirty baseline', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      projectId: 'project-1',
      projectName: 'Project',
      projectPath: 'C:/projects/original',
      projectDirty: true,
      lastSavedSnapshot: null,
    } as never);
  });

  it('uses the stable snapshot after Save As', async () => {
    const path = await useWorkflowStore.getState().saveProjectAs();

    const state = useWorkflowStore.getState();
    expect(path).toBe('C:/projects/save-as');
    expect(state.projectDirty).toBe(false);
    expect(state.isProjectDirty()).toBe(false);
    expect(state.lastSavedSnapshot).toBe(projectSnapshot(state));
  });
});
