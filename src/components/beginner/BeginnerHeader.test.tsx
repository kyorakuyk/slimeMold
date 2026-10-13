import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { formatDate } from './BeginnerHeader';

describe('BeginnerHeader date formatting', () => {
  it('formats a date using the active i18n language', async () => {
    const originalLanguage = i18n.language;
    const value = '2026-10-13T12:34:00.000Z';
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    const formatter = vi.spyOn(Date.prototype, 'toLocaleString');

    try {
      await i18n.changeLanguage('en-US');
      const result = formatDate(value);
      expect(formatter).toHaveBeenNthCalledWith(1, 'en-US', options);
      expect(result).toBe(new Date(value).toLocaleString('en-US', options));
    } finally {
      formatter.mockRestore();
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
    }
  });
});
