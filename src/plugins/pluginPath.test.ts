import { describe, expect, it } from 'vitest';
import { assertPluginRelativePath } from './pluginPath';

describe('plugin entry path boundaries', () => {
  it('allows a nested relative entry and normalizes separators', () => {
    expect(assertPluginRelativePath('nodes\\index.js')).toBe('nodes/index.js');
  });

  it.each(['../index.js', '..\\index.js', '/index.js', 'C:/index.js', 'index.js:stream', 'CON'])(
    'rejects package escape or invalid entry %s',
    (entry) => {
      expect(() => assertPluginRelativePath(entry)).toThrow();
    },
  );

  it('rejects non-string manifest values', () => {
    expect(() => assertPluginRelativePath({ path: 'index.js' })).toThrow();
  });
});
