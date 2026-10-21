import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import type { GraphGrowthProjection } from '../projectControl/graphGrowthProjection';
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
import TaskGrowthTimeline from './TaskGrowthTimeline';

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

  it('blocks split-view navigation during replay and restores it when live', () => {
    renderTopBar({ replayMode: true });
    const replayButton = container.querySelector(
      'header.sm-pro-topbar button[title="topbar.splitView"]',
    ) as HTMLButtonElement;

    expect(replayButton.disabled).toBe(true);
    act(() => {
      replayButton.focus();
      replayButton.click();
    });
    expect(document.activeElement).not.toBe(replayButton);
    expect(useViewStore.getState().splitView).toBe(false);

    renderTopBar({ replayMode: false });
    const liveButton = container.querySelector(
      'header.sm-pro-topbar button[title="topbar.splitView"]',
    ) as HTMLButtonElement;
    expect(liveButton.disabled).toBe(false);
    act(() => liveButton.click());
    expect(useViewStore.getState().splitView).toBe(true);
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

  it('routes the new-project keyboard shortcut through its container callback', () => {
    const onNewProject = vi.fn();
    renderTopBar({ onNewProject });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'N',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });

    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('disables workflow editing and run commands while replaying, then restores them live', () => {
    useWorkflowStore.setState({
      selectedNodeId: 'node-1',
      nodes: [{ id: 'node-1', type: 'default', position: { x: 0, y: 0 }, data: {} } as never],
    });
    renderTopBar({ replayMode: true });

    const fileMenu = Array.from(container.querySelectorAll('.sm-pro-menu-button')).find(
      (button) => button.textContent === 'topbar.file',
    ) as HTMLButtonElement;
    act(() => fileMenu.click());
    const newWorkflow = Array.from(container.querySelectorAll('.sm-pro-menu button')).find(
      (button) => button.textContent?.includes('menu.newWorkflow'),
    ) as HTMLButtonElement;
    expect(newWorkflow.disabled).toBe(true);

    act(() => {
      const editMenu = Array.from(container.querySelectorAll('.sm-pro-menu-button'))
        .find((button) => button.textContent === 'topbar.edit') as HTMLButtonElement;
      editMenu.click();
    });
    const deleteSelected = Array.from(container.querySelectorAll('.sm-pro-menu button')).find(
      (button) => button.textContent?.includes('menu.deleteSelected'),
    ) as HTMLButtonElement;
    expect(deleteSelected.disabled).toBe(true);

    act(() => {
      Array.from(container.querySelectorAll('.sm-pro-menu-button'))
        .find((button) => button.textContent === 'topbar.run')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
    });
    const run = Array.from(container.querySelectorAll('.sm-pro-menu button')).find(
      (button) => button.textContent?.includes('menu.runFull'),
    ) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(container.querySelector('button[title="topbar.run"]')?.hasAttribute('disabled')).toBe(true);

    renderTopBar({ replayMode: false });
    const liveRun = container.querySelector('button[title="topbar.run"]') as HTMLButtonElement;
    expect(liveRun.disabled).toBe(false);
  });

  it('blocks the new-project shortcut during replay', () => {
    const onNewProject = vi.fn();
    renderTopBar({ onNewProject, replayMode: true });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'N',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });

    expect(onNewProject).not.toHaveBeenCalled();
  });

  it('disables stop, rerun, reset, undo, and redo while replaying', () => {
    useWorkflowStore.setState({
      running: true,
      past: [{} as never],
      future: [{} as never],
    });
    renderTopBar({ replayMode: true });

    for (const title of ['topbar.stop', 'topbar.rerunForce', 'topbar.resetStatus', 'topbar.undo', 'topbar.redo']) {
      expect((container.querySelector(`button[title="${title}"]`) as HTMLButtonElement).disabled).toBe(true);
    }

    renderTopBar({ replayMode: false });
    for (const title of ['topbar.stop', 'topbar.rerunForce', 'topbar.resetStatus', 'topbar.undo', 'topbar.redo']) {
      expect((container.querySelector(`button[title="${title}"]`) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('connects timeline scrubbing to replay command gates and restores them when the parent returns live', () => {
    const events: DomainEvent[] = Array.from({ length: 4 }, (_, index) => {
      const sequence = index + 1;
      return {
        eventId: `timeline-${sequence}`,
        streamId: 'stream-1',
        sequence,
        aggregateType: 'Project',
        aggregateId: 'project-1',
        aggregateVersion: sequence,
        eventType: `Event${sequence}`,
        schemaVersion: 1,
        payload: {},
        actor: 'runtime',
        occurredAt: `2026-10-20T00:00:0${sequence}.000Z`,
      };
    });
    const baseProjection: GraphGrowthProjection = {
      uptoSeq: 4,
      lastSequence: 4,
      nodes: [],
      edges: [],
      flow: [],
      scars: [],
      rings: [],
      capsules: [],
      markers: [],
      legacyGraphIds: [],
    };
    const topBarProps: ComponentProps<typeof TopBar> = {
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
    };
    let returnToLive: (() => void) | undefined;
    function ReplayHarness() {
      const [uptoSeq, setUptoSeq] = useState(4);
      returnToLive = () => setUptoSeq(4);
      return (
        <>
          <TaskGrowthTimeline
            events={events}
            projection={{ ...baseProjection, uptoSeq }}
            onSeek={setUptoSeq}
            onReturnToLive={() => setUptoSeq(4)}
          />
          <TopBar {...topBarProps} replayMode={uptoSeq < 4} />
        </>
      );
    }
    act(() => root.render(<ReactFlowProvider><ReplayHarness /></ReactFlowProvider>));

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '2');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((container.querySelector('button[title="topbar.run"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => returnToLive?.());
    expect((container.querySelector('button[title="topbar.run"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the simple-view switch disabled until replay returns to live', () => {
    const onOpenSimpleView = vi.fn();
    renderTopBar({ onOpenSimpleView, replayMode: true });
    const replaySwitch = container.querySelector('button[title="topbar.simpleView"]') as HTMLButtonElement;

    expect(replaySwitch.disabled).toBe(true);
    act(() => replaySwitch.click());
    expect(onOpenSimpleView).not.toHaveBeenCalled();

    renderTopBar({ onOpenSimpleView, replayMode: false });
    const liveSwitch = container.querySelector('button[title="topbar.simpleView"]') as HTMLButtonElement;
    expect(liveSwitch.disabled).toBe(false);
    act(() => liveSwitch.click());
    expect(onOpenSimpleView).toHaveBeenCalledOnce();
  });
});
