import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import { type AgentConfig } from '../types/agent';
import i18n from '../i18n';

const mocks = vi.hoisted(() => ({
  fetchOllamaModels: vi.fn(),
  probeAgent: vi.fn(),
}));

vi.mock('../agents/agentManager', async () => {
  const actual = await vi.importActual<typeof import('../agents/agentManager')>('../agents/agentManager');
  return {
    ...actual,
    fetchOllamaModels: mocks.fetchOllamaModels,
    probeAgent: mocks.probeAgent,
  };
});

vi.mock('../agents/providers/codex', () => ({
  chatCodex: vi.fn(),
  codexLoginStatus: vi.fn(),
  loginCodex: vi.fn(),
  logoutCodex: vi.fn(),
}));

import AgentPanel from './AgentPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseAgent: AgentConfig = {
  id: 'agent-locale-switch',
  name: 'Local test model',
  protocol: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen2.5:3b',
  temperature: 0.7,
};

describe('AgentPanel feedback locale changes', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalLanguage: string;

  beforeEach(async () => {
    originalLanguage = i18n.language || 'zh-CN';
    await i18n.changeLanguage('zh-CN');
    localStorage.removeItem('slime-mold-workflow');
    localStorage.removeItem('sm.lastSession');
    useWorkflowStore.setState({
      agents: [{ ...baseAgent }],
      globalAgents: [],
      defaultAgentId: null,
      projectDirty: false,
    });
    mocks.fetchOllamaModels.mockReset();
    mocks.fetchOllamaModels.mockResolvedValue([]);
    mocks.probeAgent.mockReset();
    mocks.probeAgent.mockResolvedValue({
      ok: false,
      stage: 'url',
      message: i18n.t('agent.probe.ollamaStatus', { ns: 'agents', status: 503 }),
      messageSpec: { key: 'agent.probe.ollamaStatus', options: { status: 503 } },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('slime-mold-workflow');
    localStorage.removeItem('sm.lastSession');
    await i18n.changeLanguage(originalLanguage);
  });

  it('retranslates model and probe feedback after switching locale while mounted', async () => {
    await act(async () => {
      root.render(<AgentPanel embedded />);
    });
    await act(async () => {
      (container.querySelector('ul li') as HTMLLIElement).click();
    });

    mocks.fetchOllamaModels.mockRejectedValueOnce(new Error('ollama unavailable'));
    const pullButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.title === i18n.t('agent.model.pullLocal', { ns: 'agents' }),
    ) as HTMLButtonElement;
    await act(async () => {
      pullButton.click();
      await Promise.resolve();
    });

    const probeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.title === i18n.t('agent.model.probe', { ns: 'agents' }),
    ) as HTMLButtonElement;
    await act(async () => {
      probeButton.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('拉取模型失败：ollama unavailable');
    expect(container.textContent).toContain('Ollama 返回 503');

    await act(async () => {
      await i18n.changeLanguage('en-US');
    });

    expect(container.textContent).toContain('Failed to pull models: ollama unavailable');
    expect(container.textContent).toContain('Ollama returned 503');
    expect(container.textContent).not.toContain('拉取模型失败');
    expect(container.textContent).not.toContain('Ollama 返回');
    expect(mocks.fetchOllamaModels).toHaveBeenCalledTimes(1);
    expect(mocks.probeAgent).toHaveBeenCalledTimes(1);
  });
});
