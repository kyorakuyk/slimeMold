import { describe, expect, it } from 'vitest';
import { createAgent, probeAgent, protocolDefaults, providerPresets } from './agentManager';
import i18n from '../i18n';

describe('agent catalog stored values and display keys', () => {
  it('keeps the existing protocol and preset creation values stable', () => {
    expect(protocolDefaults.ollama.label).toBe('Ollama 本地');
    expect(providerPresets.find((preset) => preset.id === 'deepseek')).toMatchObject({
      id: 'deepseek',
      name: 'DeepSeek 官方',
    });

    const fromProtocol = createAgent('ollama');
    expect(fromProtocol).toMatchObject({
      name: 'Ollama 本地智能体',
      protocol: 'ollama',
    });

    const fromPreset = createAgent('openai', 'deepseek');
    expect(fromPreset).toMatchObject({
      name: 'DeepSeek 官方智能体',
      protocol: 'openai',
      providerId: 'deepseek',
    });
  });

  it('provides separate locale keys for dropdown-only protocol and preset labels', () => {
    expect(protocolDefaults.ollama).toHaveProperty('labelKey', 'agent.protocol.ollama');
    expect(providerPresets.find((preset) => preset.id === 'deepseek')).toHaveProperty(
      'labelKey',
      'agent.provider.deepseek',
    );
  });

  it('localizes probe diagnostics at the display boundary', async () => {
    const originalLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en-US');
      const english = await probeAgent({ protocol: 'openai', baseUrl: '', model: 'gpt-4o-mini' });
      expect(english.message).toBe('Base URL is empty');

      await i18n.changeLanguage('zh-CN');
      const chinese = await probeAgent({ protocol: 'openai', baseUrl: '', model: 'gpt-4o-mini' });
      expect(chinese.message).toBe('Base URL 为空');
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
    }
  });
});
