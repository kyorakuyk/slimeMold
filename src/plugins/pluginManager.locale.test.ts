import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';
import { importPluginFiles, removePlugin } from './pluginManager';

function lastLog(): { level: string; message: string } {
  const logs = useWorkflowStore.getState().logs;
  const entry = logs[logs.length - 1];
  if (!entry) throw new Error('expected a log entry');
  return { level: entry.level, message: entry.message };
}

async function withLanguage(language: string, run: () => Promise<void> | void): Promise<void> {
  const previous = i18n.language;
  const previousLocale = useViewStore.getState().locale;
  try {
    useViewStore.getState().setLocale(language);
    await i18n.changeLanguage(language);
    await run();
  } finally {
    useViewStore.getState().setLocale(previousLocale);
    await i18n.changeLanguage(previous || 'zh-CN');
  }
}

describe('plugin manager log messages follow the interface language', () => {
  it('localizes a parameterized info message', async () => {
    await withLanguage('zh-CN', () => {
      removePlugin('plugin-x');
      const entry = lastLog();
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('插件已卸载：plugin-x');
    });

    await withLanguage('en-US', () => {
      removePlugin('plugin-x');
      const entry = lastLog();
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('Plugin unloaded: plugin-x');
    });
  });

  it('localizes an error message that carries a reason', async () => {
    // jsdom's Blob has no `.text()`; stand in for that platform boundary only.
    const files = [
      {
        name: 'manifest.json',
        text: async () => '{"entry":"../escape.js"}',
      } as unknown as File,
    ];

    await withLanguage('zh-CN', async () => {
      await importPluginFiles(files);
      const entry = lastLog();
      expect(entry.level).toBe('error');
      expect(entry.message.startsWith('导入失败：manifest.entry 无效（')).toBe(true);
    });

    await withLanguage('en-US', async () => {
      await importPluginFiles(files);
      const entry = lastLog();
      expect(entry.level).toBe('error');
      expect(entry.message.startsWith('Import failed: invalid manifest.entry (')).toBe(true);
    });
  });
});
