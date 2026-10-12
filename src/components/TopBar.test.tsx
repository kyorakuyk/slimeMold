import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';

const mocks = vi.hoisted(() => ({
  openProjectFile: vi.fn(),
  runWorkflow: vi.fn(),
  stopWorkflow: vi.fn(),
  resumeRun: vi.fn(),
  rerunWorkflow: vi.fn(),
  ask: vi.fn(),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../platform/env', async () => {
  const actual = await vi.importActual<typeof import('../platform/env')>('../platform/env');
  return { ...actual, isTauri: false };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: mocks.ask }));

vi.mock('../io/projectIO', async () => {
  const actual = await vi.importActual<typeof import('../io/projectIO')>('../io/projectIO');
  return { ...actual, openProjectFile: mocks.openProjectFile };
});

vi.mock('../engine/executor', async () => {
  const actual = await vi.importActual<typeof import('../engine/executor')>('../engine/executor');
  return {
    ...actual,
    runWorkflow: mocks.runWorkflow,
    stopWorkflow: mocks.stopWorkflow,
    resumeRun: mocks.resumeRun,
    rerunWorkflow: mocks.rerunWorkflow,
  };
});

import TopBar from './TopBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function resetStores() {
  localStorage.removeItem('slime-mold-view');
  localStorage.removeItem('slime-mold-workflow');
  localStorage.removeItem('sm.lastSession');
  localStorage.removeItem('sm.recentProjects');
  useViewStore.setState({ splitView: false, showGrid: true, debugMode: false });
  useWorkflowStore.setState({
    running: false,
    failFast: true,
    skipFailed: false,
    past: [],
    future: [],
    selectedNodeId: null,
    nodes: [],
    workflows: {},
    activeWfId: '',
    projectName: null,
    projectDirty: false,
    projectPath: null,
  });
}

describe('TopBar characterization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStores();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.openProjectFile.mockReset();
    mocks.runWorkflow.mockReset();
    mocks.stopWorkflow.mockReset();
    mocks.resumeRun.mockReset();
    mocks.rerunWorkflow.mockReset();
    mocks.ask.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('slime-mold-view');
    localStorage.removeItem('slime-mold-workflow');
    localStorage.removeItem('sm.lastSession');
    localStorage.removeItem('sm.recentProjects');
    vi.restoreAllMocks();
  });

  function renderTopBar(overrides: Partial<ComponentProps<typeof TopBar>> = {}) {
    const props: ComponentProps<typeof TopBar> = {
      sidebarOpen: true,
      onToggleSidebar: vi.fn(),
      panelOpen: true,
      onTogglePanel: vi.fn(),
      inspectorOpen: true,
      onToggleInspector: vi.fn(),
      onOpenPanel: vi.fn(),
      onOpenShortcuts: vi.fn(),
      onNewProject: vi.fn(),
      onOpenWizard: vi.fn(),
      onOpenSimpleView: vi.fn(),
      ...overrides,
    };
    act(() => {
      root.render(
        <ReactFlowProvider>
          <TopBar {...props} />
        </ReactFlowProvider>,
      );
    });
    return props;
  }

  it('toggles the real split-view setting from the toolbar', () => {
    renderTopBar();
    const splitButton = container.querySelector(
      'header.sm-pro-topbar button[title="topbar.splitView"]',
    ) as HTMLButtonElement;

    act(() => splitButton.click());

    expect(useViewStore.getState().splitView).toBe(true);
    expect(splitButton.getAttribute('data-active')).toBe('true');
  });

  it('surfaces a browser-safe project-open rejection and closes the menu', async () => {
    mocks.openProjectFile.mockRejectedValueOnce(new Error('fixture open failure'));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderTopBar();

    const fileMenu = Array.from(container.querySelectorAll('.sm-pro-menu-button')).find(
      (button) => button.textContent === 'topbar.file',
    ) as HTMLButtonElement;
    act(() => fileMenu.click());
    const openProject = Array.from(container.querySelectorAll('.sm-pro-menu button')).find(
      (button) => button.textContent?.includes('menu.openProject'),
    ) as HTMLButtonElement;
    await act(async () => {
      openProject.click();
      await Promise.resolve();
    });

    expect(mocks.openProjectFile).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('dialog.openFailedfixture open failure');
    expect(container.querySelector('.sm-pro-menu')).toBeNull();
  });

  it('routes the left-sidebar control through its container callback', () => {
    const onToggleSidebar = vi.fn();
    renderTopBar({ onToggleSidebar });
    const toggle = container.querySelector(
      'header.sm-pro-topbar button[title="topbar.toggleLeft"]',
    ) as HTMLButtonElement;

    act(() => toggle.click());

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
