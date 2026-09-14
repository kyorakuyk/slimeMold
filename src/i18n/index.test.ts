import { describe, expect, it } from 'vitest';
import i18n from './index';

describe('i18n namespace fallbacks', () => {
  it('resolves NodePalette keys instead of returning raw keys', () => {
    expect(i18n.t('title')).toBe('节点库');
    expect(i18n.t('search.placeholder')).toBe('搜索节点…');
    expect(i18n.t('search.empty')).toBe('无匹配节点');
  });
});
