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
});
