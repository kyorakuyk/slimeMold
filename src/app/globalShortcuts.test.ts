import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGlobalShortcuts } from './globalShortcuts';

function baseDeps() {
  return {
    exportWorkflow: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    newWorkflowInProject: vi.fn(),
    copySelection: vi.fn(),
    pasteClipboard: vi.fn(),
    duplicateSelection: vi.fn(),
    selectAll: vi.fn(),
    toggleNodeBypass: vi.fn(),
    toggleNodeMute: vi.fn(),
    addLog: vi.fn(),
    getSelectedNodeIds: vi.fn(() => ['node-1']),
    getSubgraphCount: vi.fn(() => 2),
    createGroup: vi.fn(),
    packSelectionAsSubgraph: vi.fn(),
    promptForName: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('global shortcuts adapter', () => {
  it('routes edit shortcuts and cleans up its listener', () => {
    const deps = baseDeps();
    const dispose = installGlobalShortcuts(deps);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));

    expect(deps.undo).toHaveBeenCalledOnce();
    expect(deps.redo).toHaveBeenCalledOnce();
    expect(deps.exportWorkflow).toHaveBeenCalledOnce();
    expect(deps.newWorkflowInProject).toHaveBeenCalledOnce();

    dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(deps.undo).toHaveBeenCalledOnce();
  });

  it('keeps editable text native and routes group prompt through an injected port', () => {
    const deps = baseDeps();
    const dispose = installGlobalShortcuts(deps);
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, shiftKey: true }));

    expect(deps.undo).not.toHaveBeenCalled();
    expect(deps.promptForName).toHaveBeenCalledWith(
      '给这个子图起个名字',
      '子图 3',
      expect.any(Function),
    );

    dispose();
    input.remove();
  });

  it('blocks state-changing keyboard shortcuts in replay and restores them live', () => {
    const deps = baseDeps();
    let replayMode = true;
    const dispose = installGlobalShortcuts({ ...deps, isReplayMode: () => replayMode });

    const replayActions = ['s', 'z', 'y', 'n', 'c', 'v', 'd', 'a', 'b', 'm', 'g'];
    for (const key of replayActions) {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented, `Ctrl+${key.toUpperCase()} should be blocked in replay`).toBe(true);
    }

    expect(deps.exportWorkflow).not.toHaveBeenCalled();
    expect(deps.undo).not.toHaveBeenCalled();
    expect(deps.redo).not.toHaveBeenCalled();
    expect(deps.newWorkflowInProject).not.toHaveBeenCalled();
    expect(deps.copySelection).not.toHaveBeenCalled();
    expect(deps.pasteClipboard).not.toHaveBeenCalled();
    expect(deps.duplicateSelection).not.toHaveBeenCalled();
    expect(deps.selectAll).not.toHaveBeenCalled();
    expect(deps.toggleNodeBypass).not.toHaveBeenCalled();
    expect(deps.toggleNodeMute).not.toHaveBeenCalled();
    expect(deps.createGroup).not.toHaveBeenCalled();

    replayMode = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(deps.undo).toHaveBeenCalledOnce();
    expect(deps.copySelection).toHaveBeenCalledOnce();
    expect(deps.pasteClipboard).toHaveBeenCalledOnce();
    expect(deps.redo).toHaveBeenCalledOnce();
    dispose();
  });

  it('preserves native editable-field shortcuts during replay while blocking app commands', () => {
    const deps = baseDeps();
    const dispose = installGlobalShortcuts({ ...deps, isReplayMode: () => true });
    const input = document.createElement('input');
    document.body.append(input);

    const nativeShortcuts = ['z', 'y', 'c', 'v', 'd', 'a', 'b', 'm'];
    for (const key of nativeShortcuts) {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented, `Ctrl+${key.toUpperCase()} should remain native in an input`).toBe(false);
    }

    for (const key of ['s', 'n', 'g']) {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented, `Ctrl+${key.toUpperCase()} remains an app command`).toBe(true);
    }

    expect(deps.copySelection).not.toHaveBeenCalled();
    expect(deps.pasteClipboard).not.toHaveBeenCalled();
    expect(deps.undo).not.toHaveBeenCalled();
    expect(deps.exportWorkflow).not.toHaveBeenCalled();
    expect(deps.newWorkflowInProject).not.toHaveBeenCalled();
    dispose();
    input.remove();
  });
});
