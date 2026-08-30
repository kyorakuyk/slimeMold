import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const projectFile = {
    version: 1 as const,
    kind: 'project' as const,
    id: 'proj-1',
    name: 'SMtest',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    activeId: 'wf-1',
    workflows: {
      'wf-1': {
        version: 1 as const,
        name: 'Workflow 1',
        savedAt: '2026-08-30T00:00:00.000Z',
        nodes: [],
        edges: [],
        agents: [],
        roles: [],
        variables: {},
      },
    },
  };
  const recent = [{
    name: 'SMtest',
    path: 'D:/Agents/SMtest',
    openedAt: '2026-08-30T02:12:00.000Z',
  }];
  const store = {
    projectId: 'proj-1',
    projectName: 'SMtest',
    projectPath: 'D:/Agents/SMtest',
    projectDirty: false,
    workflows: {
      'wf-1': { name: 'Workflow 1', nodes: [], edges: [] },
    },
    activeWfId: 'wf-1',
    nodes: [],
    runHistory: [],
    running: false,
    runProgress: { layer: 0, totalLayers: 0 },
    runStates: {},
    artifacts: {},
    openProject: vi.fn(() => true),
    switchWorkflow: vi.fn(),
  };
  return {
    projectFile,
    recent,
    store,
    getRecentProjects: vi.fn(() => recent),
    openProjectByPath: vi.fn(async () => projectFile),
    openProjectFile: vi.fn(async () => projectFile),
    pushRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    saveLastSession: vi.fn(),
    clearRecentProjects: vi.fn(),
  };
});

vi.mock('../io/projectIO', () => ({
  clearRecentProjects: mocks.clearRecentProjects,
  getRecentProjects: mocks.getRecentProjects,
  openProjectByPath: mocks.openProjectByPath,
  openProjectFile: mocks.openProjectFile,
  pushRecentProject: mocks.pushRecentProject,
  removeRecentProject: mocks.removeRecentProject,
  saveLastSession: mocks.saveLastSession,
}));

vi.mock('../engine/executor', () => ({
  runWorkflow: vi.fn(),
  stopWorkflow: vi.fn(),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

import BeginnerExperience from './BeginnerExperience';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BeginnerExperience project navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.store.openProject.mockClear();
    mocks.openProjectByPath.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('enters the cockpit when reopening the already-loaded project from the home page', async () => {
    await act(async () => {
      root.render(
        <BeginnerExperience
          onOpenAdvanced={vi.fn()}
          onNewProject={vi.fn()}
        />,
      );
    });

    const backButton = container.querySelector('.sm-beginner-back-link');
    expect(backButton).not.toBeNull();
    await act(async () => {
      (backButton as HTMLButtonElement).click();
    });
    expect(container.querySelector('.sm-beginner-recent-row')).not.toBeNull();

    await act(async () => {
      (container.querySelector('.sm-beginner-recent-row') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.openProjectByPath).toHaveBeenCalledWith('D:/Agents/SMtest');
    expect(mocks.store.openProject).toHaveBeenCalledWith(
      mocks.projectFile,
      'D:/Agents/SMtest',
    );
    expect(container.querySelector('.sm-beginner-project-main')).not.toBeNull();
  });
});
