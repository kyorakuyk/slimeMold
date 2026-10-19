import { describe, expect, it } from 'vitest';
import { checkPlaceholderConsistency } from './placeholderCheck';

const translation = (language: string, key: string, value: string, namespace = 'test') => ({
  language,
  namespace,
  key,
  value,
});

describe('checkPlaceholderConsistency', () => {
  it('reports single-brace interpolation tokens', () => {
    expect(checkPlaceholderConsistency([
      translation('zh-CN', 'greeting', '你好，{name}'),
    ])).toEqual([
      {
        code: 'single-brace-placeholder',
        language: 'zh-CN',
        namespace: 'test',
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
        namespace: 'test',
        key: 'settings.description',
        baseLanguage: 'zh-CN',
        basePlaceholders: ['工作流', '运行号'],
        comparedLanguage: 'en-US',
        comparedPlaceholders: ['run', 'workflow'],
      },
    ]);
  });

  it('compares duplicate keys only within the same namespace', () => {
    expect(checkPlaceholderConsistency([
      translation('zh-CN', 'shared.key', '{{count}}', 'ui'),
      translation('en-US', 'shared.key', '{{count}}', 'ui'),
      translation('zh-CN', 'shared.key', '{{name}}', 'panels'),
      translation('en-US', 'shared.key', '{{name}}', 'panels'),
    ])).toEqual([]);
  });
});
