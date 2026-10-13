import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import StatusBar from './StatusBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockStatusStore = {
  logs: Array<{ time: string; level: string; message: string }>;
  running: boolean;
  debugRun: { current: number; active: number };
  clearLogs: () => void;
  nodes: unknown[];
  variables: Record<string, unknown>;
  runHistory: unknown[];
  lastAutosave: number;
  setAutosave: () => void;
};

const { mockState, useWorkflowStoreMock } = vi.hoisted(() => {
  const mockState: MockStatusStore = {
    logs: [],
    running: false,
    debugRun: { current: 0, active: 0 },
    clearLogs: () => {},
    nodes: [],
    variables: {},
    runHistory: [],
    lastAutosave: 0,
    setAutosave: () => {},
  };
  const useWorkflowStoreMock = Object.assign(
    (selector: (state: MockStatusStore) => unknown) => selector(mockState),
    { getState: () => mockState },
  );
  return { mockState, useWorkflowStoreMock };
});

vi.mock('../store/workflowStore', () => ({ useWorkflowStore: useWorkflowStoreMock }));
vi.mock('../engine/executor', () => ({ stopWorkflow: () => {} }));
vi.mock('./ArtifactsPanel', () => ({ ArtifactsPanel: () => null }));
vi.mock('./DevSessionPanel', () => ({ DevSessionPanel: () => null }));

describe('StatusBar locale formatting', () => {
  it('formats the autosave time using the active i18n language', async () => {
    const originalLanguage = i18n.language;
    const originalHtmlLanguage = document.documentElement.lang;
    const originalTitle = document.title;
    const timestamp = Date.parse('2026-10-13T12:34:56.000Z');
    const expected = new Date(timestamp).toLocaleTimeString('en-US');
    const formatter = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    const container = document.createElement('div');
    const root = createRoot(container);
    mockState.lastAutosave = timestamp;

    try {
      await i18n.changeLanguage('en-US');
      await act(async () => {
        root.render(<StatusBar open={false} onToggle={() => {}} />);
      });

      expect(formatter).toHaveBeenCalledTimes(1);
      expect(formatter).toHaveBeenCalledWith('en-US');
      expect(container.textContent).toContain(expected);
    } finally {
      formatter.mockRestore();
      await act(async () => root.unmount());
      container.remove();
      mockState.lastAutosave = 0;
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
      document.documentElement.lang = originalHtmlLanguage;
      document.title = originalTitle;
    }
  });
});
