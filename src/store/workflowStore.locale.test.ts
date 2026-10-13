import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { useViewStore } from './viewStore';
import { useWorkflowStore } from './workflowStore';

describe('workflow log locale formatting', () => {
  it('uses the selected view locale for log timestamps', async () => {
    const originalLocale = useViewStore.getState().locale;
    const originalLogs = useWorkflowStore.getState().logs;
    const formatter = vi.spyOn(Date.prototype, 'toLocaleTimeString');

    try {
      useViewStore.getState().setLocale('en-US');
      await i18n.changeLanguage('en-US');
      useWorkflowStore.getState().addLog('info', 'locale-test');

      expect(formatter).toHaveBeenCalledWith('en-US');
    } finally {
      formatter.mockRestore();
      useWorkflowStore.setState({ logs: originalLogs });
      useViewStore.getState().setLocale(originalLocale);
      await i18n.changeLanguage(originalLocale || 'zh-CN');
    }
  });
});
