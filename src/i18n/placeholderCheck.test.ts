import { describe, expect, it } from 'vitest';
import { checkPlaceholderConsistency } from './placeholderCheck';

const translation = (language: string, key: string, value: string) => ({ language, key, value });

describe('checkPlaceholderConsistency', () => {
  it('reports single-brace interpolation tokens', () => {
    expect(checkPlaceholderConsistency([
      translation('zh-CN', 'greeting', '你好，{name}'),
    ])).toEqual([
      {
        code: 'single-brace-placeholder',
        language: 'zh-CN',
        key: 'greeting',
        placeholders: ['name'],
      },
    ]);
  });

  it('accepts matching double-brace interpolation tokens', () => {
    expect(checkPlaceholderConsistency([
      translation('zh-CN', 'history.count', '共 {{count}} 次'),
      translation('en-US', 'history.count', '{{count}} runs'),
    ])).toEqual([]);
  });

  it('reports different placeholder sets for the same key', () => {
    expect(checkPlaceholderConsistency([
      translation('zh-CN', 'settings.description', '工作流 {{工作流}}，运行号 {{运行号}}'),
      translation('en-US', 'settings.description', 'Workflow {{workflow}}, run {{run}}'),
    ])).toEqual([
      {
        code: 'placeholder-set-mismatch',
        key: 'settings.description',
        baseLanguage: 'zh-CN',
        basePlaceholders: ['工作流', '运行号'],
        comparedLanguage: 'en-US',
        comparedPlaceholders: ['run', 'workflow'],
      },
    ]);
  });
});
