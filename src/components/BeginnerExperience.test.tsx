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
    projectId: 'proj-1' as string | null,
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
    projectControl: {
      version: 1 as const,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    },
    openProject: vi.fn(() => true),
    switchWorkflow: vi.fn(),
    setProjectControl: vi.fn(),
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
    mocks.store.projectId = 'proj-1';
    mocks.store.projectName = 'SMtest';
    mocks.store.projectPath = 'D:/Agents/SMtest';
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    };
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
          onStartProjectSession={vi.fn()}
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

  it('keeps advanced navigation out of the empty home and starts a project session from a goal', async () => {
    mocks.store.projectId = null;
    const onStartProjectSession = vi.fn();
    await act(async () => {
      root.render(
        <BeginnerExperience
          onOpenAdvanced={vi.fn()}
          onNewProject={vi.fn()}
          onStartProjectSession={onStartProjectSession}
        />,
      );
    });

    expect(container.querySelector('.sm-beginner-nav-link')).toBeNull();
    const input = container.querySelector('#beginner-project-goal') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setNativeValue.call(input, '帮我做一个个人记账应用');
    await act(async () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('.sm-beginner-goal-box button') as HTMLButtonElement).click();
    });

    expect(onStartProjectSession).toHaveBeenCalledWith('帮我做一个个人记账应用');
  });
});
