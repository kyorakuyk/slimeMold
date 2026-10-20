import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphGrowthProjection } from '../projectControl/graphGrowthProjection';
import { clearProjectEventBuffer, recordProjectEvents } from '../projectControl/eventBuffer';
import { eventStream, graph, GRAPH_ID, PROJECT_ID, task } from '../projectControl/graphGrowthProjectionTestUtils';

vi.mock('../canvas/LivingGraph', async () => {
  const React = await import('react');
  return {
    default: ({ projection }: { projection: GraphGrowthProjection }) => {
      const taskIds = projection.nodes
        .filter((node) => node.kind === 'task')
        .map((node) => node.taskId)
        .filter((id): id is string => !!id);
      return React.createElement('div', {
        'data-testid': 'workspace-living-graph',
        'data-task-ids': taskIds.join(','),
        'data-empty': taskIds.length === 0,
      });
    },
  };
});

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) => (
    options ? `${key} ${Object.values(options).join(' ')}` : key
  ),
}));

import ProfessionalCanvasWorkspace from './ProfessionalCanvasWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function eventRecords(taskId: string, moduleId: string) {
  const stream = eventStream();
  stream.addGraph(graph(GRAPH_ID, [task(taskId, moduleId)]));
  stream.addStarted(taskId);
  return stream.events;
}

function eventText(taskId: string, moduleId: string): string {
  return eventRecords(taskId, moduleId).map((event) => JSON.stringify(event)).join('\n');
}

function EditorProbe({ isActive }: { isActive: boolean }) {
  const [count, setCount] = useState(0);
  return <button data-testid="editor-probe" data-active={isActive} onClick={() => setCount((value) => value + 1)}>editor {count}</button>;
}

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

describe('ProfessionalCanvasWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearProjectEventBuffer(PROJECT_ID);
    vi.restoreAllMocks();
  });

  function renderWorkspace(options: {
    projectRoot: string | null;
    projectId?: string | null;
    isTauri: boolean;
    adapter?: { readText: (path: string) => Promise<string | null> };
    onReplayModeChange?: (replaying: boolean) => void;
    projectKey?: string;
    editor?: ReactNode;
  }) {
    act(() => root.render(
      <ProfessionalCanvasWorkspace
        key={options.projectKey ?? options.projectRoot ?? 'no-project'}
        projectRoot={options.projectRoot}
        projectId={options.projectId ?? null}
        isTauri={options.isTauri}
        eventStoreAdapter={options.adapter}
        onReplayModeChange={options.onReplayModeChange ?? vi.fn()}
        renderEditor={(isActive) => options.editor ?? <EditorProbe isActive={isActive} />}
      />,
    ));
  }

  it('loads the current project event stream, projects its graph, and reports replay mode', async () => {
    const projectRoot = 'C:/synthetic/project-a';
    const readText = vi.fn(async (path: string) => {
      expect(path).toBe(`${projectRoot}/.slimemold/events/events.jsonl`);
      return eventText('task-a', 'module-a');
    });
    const onReplayModeChange = vi.fn();
    renderWorkspace({ projectRoot, isTauri: true, adapter: { readText }, onReplayModeChange });

    await waitForUi(() => expect(readText).toHaveBeenCalledOnce());
    await waitForUi(() => {
      expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-task-ids'))
        .toBe('task-a');
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(onReplayModeChange).toHaveBeenLastCalledWith(false);

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.max).toBe('2');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '1');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onReplayModeChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('[data-testid="timeline-replay-state"]')).not.toBeNull();

    act(() => (container.querySelector('[data-testid="timeline-return-live"]') as HTMLButtonElement).click());
    expect(onReplayModeChange).toHaveBeenLastCalledWith(false);
  });

  it('projects the active project-session event buffer before the project has a disk root', async () => {
    clearProjectEventBuffer(PROJECT_ID);
    recordProjectEvents(PROJECT_ID, eventRecords('session-task', 'session-module'));
    renderWorkspace({ projectId: PROJECT_ID, projectRoot: null, isTauri: false });

    await waitForUi(() => {
      expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-task-ids'))
        .toBe('session-task');
    });
    expect(container.querySelector('[data-testid="workspace-event-error"]')).toBeNull();
  });

  it('shows empty state without reading browser/no-project data and for an eventless project', async () => {
    const readText = vi.fn(async () => null);
    renderWorkspace({ projectRoot: null, isTauri: false, adapter: { readText } });
    await waitForUi(() => expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-empty')).toBe('true'));
    expect(readText).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="timeline-empty"]')).not.toBeNull();

    const projectRoot = 'C:/synthetic/empty-project';
    renderWorkspace({ projectRoot, isTauri: true, adapter: { readText } });
    await waitForUi(() => expect(readText).toHaveBeenCalledWith(`${projectRoot}/.slimemold/events/events.jsonl`));
    expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-empty')).toBe('true');
    expect(container.querySelector('[data-testid="timeline-empty"]')).not.toBeNull();
  });

  it('keeps the editor mounted across view tabs and resets the keyed workspace on project switch', async () => {
    const projectA = 'C:/synthetic/project-a';
    const projectB = 'C:/synthetic/project-b';
    const readText = vi.fn(async (path: string) => (
      path.includes('project-a') ? eventText('task-a', 'module-a') : eventText('task-b', 'module-b')
    ));
    const adapter = { readText };
    renderWorkspace({ projectRoot: projectA, isTauri: true, adapter });
    await waitForUi(() => expect(readText).toHaveBeenCalled());
    expect(readText).toHaveBeenCalledWith(`${projectA}/.slimemold/events/events.jsonl`);
    await waitForUi(() => expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-task-ids')).toBe('task-a'));

    act(() => (container.querySelector('[data-testid="workspace-editor-tab"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="editor-probe"]')?.getAttribute('data-active')).toBe('true');
    act(() => (container.querySelector('[data-testid="editor-probe"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="editor-probe"]')?.textContent).toBe('editor 1');
    act(() => (container.querySelector('[data-testid="workspace-graph-tab"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="editor-probe"]')?.getAttribute('data-active')).toBe('false');
    act(() => (container.querySelector('[data-testid="workspace-editor-tab"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="editor-probe"]')?.textContent).toBe('editor 1');

    renderWorkspace({ projectRoot: projectB, isTauri: true, adapter });
    await waitForUi(() => expect(readText).toHaveBeenCalledWith(`${projectB}/.slimemold/events/events.jsonl`));
    await waitForUi(() => expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-task-ids')).toBe('task-b'));
    expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-task-ids')).not.toContain('task-a');
    expect((container.querySelector('[data-testid="workspace-graph-tab"]') as HTMLButtonElement).getAttribute('aria-selected')).toBe('true');
  });

  it('returns to the read-only graph and locks the editor during replay', async () => {
    const projectRoot = 'C:/synthetic/project-replay';
    const readText = vi.fn(async () => eventText('task-replay', 'module-replay'));
    renderWorkspace({ projectRoot, isTauri: true, adapter: { readText } });
    await waitForUi(() => expect(readText).toHaveBeenCalledOnce());

    const editorTab = container.querySelector('[data-testid="workspace-editor-tab"]') as HTMLButtonElement;
    const graphTab = container.querySelector('[data-testid="workspace-graph-tab"]') as HTMLButtonElement;
    act(() => editorTab.click());
    expect(editorTab.getAttribute('aria-selected')).toBe('true');

    const editorProbe = container.querySelector('[data-testid="editor-probe"]') as HTMLButtonElement;
    act(() => editorProbe.click());
    expect(editorProbe.textContent).toBe('editor 1');

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '1');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="timeline-replay-state"]')).not.toBeNull();
    expect(editorTab.disabled).toBe(true);
    expect(graphTab.getAttribute('aria-selected')).toBe('true');
    expect(editorTab.getAttribute('aria-selected')).toBe('false');
    expect((container.querySelector('[data-testid="workspace-editor-panel"]') as HTMLElement).hidden).toBe(true);
    expect(editorProbe.getAttribute('data-active')).toBe('false');

    act(() => editorTab.click());
    expect(graphTab.getAttribute('aria-selected')).toBe('true');
    act(() => (container.querySelector('[data-testid="timeline-return-live"]') as HTMLButtonElement).click());
    expect(editorTab.disabled).toBe(false);
    act(() => editorTab.click());
    expect(editorProbe.getAttribute('data-active')).toBe('true');
    expect(editorProbe.textContent).toBe('editor 1');
  });

  it('surfaces event read failures instead of presenting them as an empty successful read', async () => {
    const projectRoot = 'C:/synthetic/project-error';
    const readText = vi.fn(async () => { throw new Error('synthetic read failure'); });
    renderWorkspace({ projectRoot, isTauri: true, adapter: { readText } });

    await waitForUi(() => expect(readText).toHaveBeenCalledOnce());
    await waitForUi(() => expect(container.querySelector('[role="alert"][data-testid="workspace-event-error"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="workspace-living-graph"]')?.getAttribute('data-empty')).toBe('true');
  });
});
