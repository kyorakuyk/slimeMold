import { describe, expect, it } from 'vitest';
import i18n from './index';

describe('i18n namespace fallbacks', () => {
  it('resolves NodePalette keys instead of returning raw keys', () => {
    expect(i18n.t('title')).toBe('节点库');
    expect(i18n.t('search.placeholder')).toBe('搜索节点…');
    expect(i18n.t('search.empty')).toBe('无匹配节点');
  });
});

describe('document locale metadata', () => {
  it('updates the document language and title when the locale changes', async () => {
    const originalLanguage = i18n.language;
    const originalHtmlLanguage = document.documentElement.lang;
    const originalTitle = document.title;
    document.documentElement.lang = 'stale-language';
    document.title = 'stale-title';

    try {
      await i18n.changeLanguage('en-US');
      expect(document.documentElement.lang).toBe('en-US');
      expect(document.title).toBe('SlimeMold · Agent Workflows');

      await i18n.changeLanguage('zh-CN');
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(document.title).toBe('SlimeMold · Agent 工作流');
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
      document.documentElement.lang = originalHtmlLanguage;
      document.title = originalTitle;
    }
  });
});
