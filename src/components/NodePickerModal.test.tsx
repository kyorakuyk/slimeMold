import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registryState: {
    defs: {
      'input.text': {
        typeId: 'input.text',
        name: 'Text Input',
        category: '输入',
        description: 'Text input',
      },
    },
  },
  workflowState: {
    subgraphs: {
      'subgraph-1': {
        id: 'subgraph-1',
        name: 'Reusable subgraph',
        nodes: [{ id: 'node-1' }, { id: 'node-2' }],
      },
    },
  },
}));

vi.mock('../store/registryStore', () => ({
  useRegistryStore: (selector: (state: typeof mocks.registryState) => unknown) => selector(mocks.registryState),
}));
vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.workflowState) => unknown) => selector(mocks.workflowState),
    { getState: () => mocks.workflowState },
  ),
}));
vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: { count?: number }) =>
    key === 'nodePicker.mySubgraph' ? 'My subgraphs'
      : key === 'nodePicker.steps' ? `${options?.count ?? 0} steps`
        : key === 'canvas.node.category.input' ? 'Input'
          : key,
}));

import { NodePickerModal } from './NodePickerModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NodePickerModal pending connection filtering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hides subgraphs when opened from a pending connection', async () => {
    const props = {
      screenPos: { x: 0, y: 0 },
      onSelect: vi.fn(),
      onClose: vi.fn(),
      showSubgraphs: false,
    };
    await act(async () => root.render(<NodePickerModal {...props} />));
    expect(container.textContent).not.toContain('Reusable subgraph');
    expect(container.textContent).toContain('Text Input');
  });

  it('continues showing subgraphs in the ordinary picker', async () => {
    const props = {
      screenPos: { x: 0, y: 0 },
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    await act(async () => root.render(<NodePickerModal {...props} />));
    expect(container.textContent).toContain('Reusable subgraph');
  });

  it('localizes built-in categories without rewriting catalog values', async () => {
    const props = {
      screenPos: { x: 0, y: 0 },
      onSelect: vi.fn(),
      onClose: vi.fn(),
      showSubgraphs: false,
    };
    await act(async () => root.render(<NodePickerModal {...props} />));

    const categoryLabel = Array.from(container.querySelectorAll('button span')).find(
      (span) => span.textContent?.trim() === 'Input' || span.textContent?.trim() === '输入',
    );
    expect(categoryLabel?.textContent?.trim()).toBe('Input');
    expect(container.textContent).not.toContain('输入');
    expect(mocks.registryState.defs['input.text']?.category).toBe('输入');
  });
});
