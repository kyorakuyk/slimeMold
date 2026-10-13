import { describe, expect, it } from 'vitest';
import i18n from './index';

const localizedLabels = [
  ['agent.protocol.openai', 'OpenAI-compatible', 'OpenAI 兼容'],
  ['agent.protocol.anthropic', 'Anthropic', 'Anthropic'],
  ['agent.protocol.ollama', 'Ollama (local)', 'Ollama 本地'],
  ['agent.protocol.codex', 'OpenAI Codex (ChatGPT subscription)', 'OpenAI Codex（ChatGPT 订阅）'],
  ['agent.protocol.antigravity', 'Antigravity CLI (interactive)', 'Antigravity CLI（交互式）'],
  ['agent.provider.openai', 'OpenAI (official)', 'OpenAI 官方'],
  ['agent.provider.deepseek', 'DeepSeek (official)', 'DeepSeek 官方'],
  ['agent.provider.siliconflow', 'SiliconFlow', '硅基流动 SiliconFlow'],
  ['agent.provider.openrouter', 'OpenRouter (aggregator)', 'OpenRouter 聚合'],
  ['agent.provider.custom', 'Custom relay', '自定义中转'],
  ['agent.provider.codex', 'OpenAI Codex (ChatGPT subscription)', 'OpenAI Codex（ChatGPT 订阅）'],
  ['agent.provider.antigravity', 'Antigravity CLI (interactive)', 'Antigravity CLI（交互式）'],
] as const;

describe('R5 Slice2 localized display labels', () => {
  it.each(localizedLabels)('%s resolves in both supported locales', (key, english, chinese) => {
    expect(i18n.t(key, { lng: 'en-US' })).toBe(english);
    expect(i18n.t(key, { lng: 'zh-CN' })).toBe(chinese);
  });

  it('uses singular and plural model-call labels', () => {
    expect(i18n.t('token.modelCalls', { count: 1, lng: 'en-US' })).toBe('1 call');
    expect(i18n.t('token.modelCalls', { count: 3, lng: 'en-US' })).toBe('3 calls');
    expect(i18n.t('token.modelCalls', { count: 1, lng: 'zh-CN' })).toBe('1 次调用');
    expect(i18n.t('token.modelCalls', { count: 3, lng: 'zh-CN' })).toBe('3 次调用');
  });

  it('localizes model recommendations while retaining technical model IDs', () => {
    expect(i18n.t('agent.model.note.qwen25_3b', { lng: 'en-US' })).toBe('~2GB VRAM · recommended for 6GB GPUs, runs smoothly');
    expect(i18n.t('agent.model.note.qwen25_7b', { lng: 'en-US' })).toBe('~4.5GB VRAM · better quality, tight on 6GB');
    expect(i18n.t('agent.model.note.llama31_8b', { lng: 'en-US' })).toBe('~5GB VRAM · recommended for 8GB+ GPUs');
    expect(i18n.t('agent.model.note.deepseekR1_7b', { lng: 'en-US' })).toBe('~4.5GB VRAM · strong reasoning, tight on 6GB');
    expect(i18n.t('agent.model.note.qwen25_05b', { lng: 'en-US' })).toBe('~0.5GB VRAM · ultra-light');
  });

  it('pluralizes the R4 count-bearing English runtime messages', () => {
    expect(i18n.t('log.resumeFromBreakpoint', { count: 1, lng: 'en-US' })).toBe(
      'Resuming from breakpoint: recomputing 1 failed node and its downstream',
    );
    expect(i18n.t('log.resumeFromBreakpoint', { count: 2, lng: 'en-US' })).toBe(
      'Resuming from breakpoint: recomputing 2 failed nodes and their downstream',
    );
    expect(i18n.t('log.subgraphExpanded', { count: 1, lng: 'en-US' })).toBe(
      'Subgraph expanded: 1 internal step added',
    );
    expect(i18n.t('log.subgraphExpanded', { count: 2, lng: 'en-US' })).toBe(
      'Subgraph expanded: 2 internal steps added',
    );
    expect(i18n.t('log.runStarted', { mode: 'full', count: 1, lng: 'en-US' })).toBe(
      'Run started (full) with 1 node',
    );
    expect(i18n.t('log.runStarted', { mode: 'full', count: 2, lng: 'en-US' })).toBe(
      'Run started (full) with 2 nodes',
    );
  });

  it('localizes route, status punctuation, cycle-label separators, and the actual plugin action name', () => {
    expect(i18n.t('route.fallbackLabel', { lng: 'en-US' })).toBe('Fallback chain');
    expect(i18n.t('route.fallbackLabel', { lng: 'zh-CN' })).toBe('回退链');
    expect(i18n.t('runHistory.status.label', { lng: 'en-US' })).toBe('Status:');
    expect(i18n.t('runHistory.status.label', { lng: 'zh-CN' })).toBe('状态：');
    expect(i18n.t('log.cycleLabelsSeparator', { lng: 'en-US' })).toBe(', ');
    expect(i18n.t('log.cycleLabelsSeparator', { lng: 'zh-CN' })).toBe('、');
    expect(i18n.t('plugin.log.browserNoDirScan', { lng: 'en-US' })).toContain('Import from file');
  });
});
