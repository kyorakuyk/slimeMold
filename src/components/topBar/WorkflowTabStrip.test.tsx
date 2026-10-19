import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowTabStrip from './WorkflowTabStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkflowTabStrip replay gate', () => {
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
    vi.restoreAllMocks();
  });

  it('blocks workflow switching, rename, removal, and creation in history and restores them live', () => {
    const onSwitch = vi.fn();
    const onRename = vi.fn();
    const onRemove = vi.fn();
    const onNewWorkflow = vi.fn();
    const setEditingId = vi.fn();
    const props = {
      projectName: 'Fixture Project',
      projectDirty: false,
      wfList: [['wf-1', { name: 'Fixture Workflow' }] as [string, { name: string }]],
      activeWfId: 'wf-1',
      editingId: 'wf-1',
      setEditingId,
      onSwitch,
      onRename,
      onRemove,
      onNewWorkflow,
      replayMode: true,
      t: (key: string) => key,
    };
    act(() => root.render(<WorkflowTabStrip {...props} />));

    expect(container.querySelector('input')).toBeNull();
    const workflow = Array.from(container.querySelectorAll('.sm-pro-workflow-tab button'))
      .find((button) => button.textContent?.includes('Fixture Workflow')) as HTMLButtonElement;
    const close = container.querySelector('button[title="topbar.closeWorkflow"]') as HTMLButtonElement;
    const create = Array.from(container.querySelectorAll('.sm-pro-workflow-tabs > button'))[0] as HTMLButtonElement;
    expect(workflow.disabled).toBe(true);
    expect(close.disabled).toBe(true);
    expect(create.disabled).toBe(true);

    act(() => {
      workflow.click();
      workflow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      close.click();
      create.click();
    });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(setEditingId).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onNewWorkflow).not.toHaveBeenCalled();

    act(() => root.render(<WorkflowTabStrip {...props} editingId={null} replayMode={false} />));
    expect((Array.from(container.querySelectorAll('.sm-pro-workflow-tab button'))
      .find((button) => button.textContent?.includes('Fixture Workflow')) as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('button[title="topbar.closeWorkflow"]') as HTMLButtonElement).disabled).toBe(false);
    expect((Array.from(container.querySelectorAll('.sm-pro-workflow-tabs > button'))[0] as HTMLButtonElement).disabled).toBe(false);
  });
});
