import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types/agent';

const mocks = vi.hoisted(() => {
  const store = {
    agents: [] as AgentConfig[],
    globalAgents: [] as AgentConfig[],
    defaultAgentId: null as string | null,
    roles: [] as Array<{ id: string; name: string; system: string; contextScope: 'shared' | 'isolated'; builtin?: boolean }>,
    upsertAgent: vi.fn((agent: AgentConfig) => {
      const index = store.agents.findIndex((item) => item.id === agent.id);
      store.agents = index < 0
        ? [...store.agents, agent]
        : store.agents.map((item, itemIndex) => (itemIndex === index ? agent : item));
    }),
    removeAgent: vi.fn((id: string) => {
      store.agents = store.agents.filter((agent) => agent.id !== id);
    }),
    upsertGlobalAgent: vi.fn((agent: AgentConfig) => {
      const index = store.globalAgents.findIndex((item) => item.id === agent.id);
      store.globalAgents = index < 0
        ? [...store.globalAgents, agent]
        : store.globalAgents.map((item, itemIndex) => (itemIndex === index ? agent : item));
    }),
    removeGlobalAgent: vi.fn((id: string) => {
      store.globalAgents = store.globalAgents.filter((agent) => agent.id !== id);
    }),
    setDefaultAgent: vi.fn((id: string | null) => {
      store.defaultAgentId = id;
    }),
    upsertRole: vi.fn(),
    removeRole: vi.fn(),
  };
  const fetchOllamaModels = vi.fn();
  return { store, fetchOllamaModels };
});

vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

vi.mock('../store/viewStore', () => ({
  useViewStore: {
    getState: () => ({ globalProxyUrl: '' }),
  },
}));

vi.mock('../agents/agentManager', async () => {
  const actual = await vi.importActual<typeof import('../agents/agentManager')>('../agents/agentManager');
  return { ...actual, fetchOllamaModels: mocks.fetchOllamaModels };
});

vi.mock('../agents/providers/codex', () => ({
  chatCodex: vi.fn(),
  codexLoginStatus: vi.fn(),
  loginCodex: vi.fn(),
  logoutCodex: vi.fn(),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

import AgentPanel from './AgentPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseAgent: AgentConfig = {
  id: 'agent-1',
  name: '本地模型',
  protocol: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen2.5:3b',
  temperature: 0.7,
};

describe('AgentPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.store.agents = [{ ...baseAgent }];
    mocks.store.globalAgents = [];
    mocks.store.defaultAgentId = null;
    mocks.store.roles = [];
    mocks.store.upsertAgent.mockClear();
    mocks.store.removeAgent.mockClear();
    mocks.store.upsertGlobalAgent.mockClear();
    mocks.store.removeGlobalAgent.mockClear();
    mocks.store.setDefaultAgent.mockClear();
    mocks.store.upsertRole.mockClear();
    mocks.store.removeRole.mockClear();
    mocks.fetchOllamaModels.mockReset();
    mocks.fetchOllamaModels.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('writes an edited agent field through the catalog action', async () => {
    await act(async () => {
      root.render(<AgentPanel embedded />);
    });

    await act(async () => {
      (container.querySelector('ul li') as HTMLLIElement).click();
    });

    const nameInput = container.querySelector('input') as HTMLInputElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setNativeValue.call(nameInput, '更新后的模型');
    await act(async () => {
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(mocks.store.agents[0]).toMatchObject({ id: 'agent-1', name: '更新后的模型' });
    expect(mocks.store.upsertAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1', name: '更新后的模型' }),
    );
  });

  it('surfaces Ollama model-pull failures and clears loading state', async () => {
    mocks.fetchOllamaModels.mockRejectedValueOnce(new Error('ollama unavailable'));

    await act(async () => {
      root.render(<AgentPanel embedded />);
    });
    await act(async () => {
      (container.querySelector('ul li') as HTMLLIElement).click();
    });

    const refreshButton = container.querySelector('button[title="agent.model.pullLocal"]') as HTMLButtonElement;
    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('agent.model.pullFailed');
    expect(container.textContent).toContain('ollama unavailable');
    expect(refreshButton.disabled).toBe(false);
  });

  it('preserves embedded and sidebar container contracts', async () => {
    const host = document.createElement('div');
    host.className = 'flex min-h-0 flex-1';
    container.appendChild(host);

    await act(async () => {
      root.render(
        <div className="flex min-h-0 flex-1">
          <AgentPanel embedded />
        </div>,
      );
    });
    expect(container.querySelector('.flex.min-h-0.flex-1')).not.toBeNull();

    await act(async () => {
      root.render(<AgentPanel variant="sidebar" />);
    });
    expect(Array.from(container.querySelectorAll('div')).some((element) =>
      element.className.includes('overflow-visible'),
    )).toBe(true);

    await act(async () => {
      (container.querySelector('ul li') as HTMLLIElement).click();
    });
    expect(Array.from(container.querySelectorAll('div')).some((element) =>
      element.className.includes('absolute left-full'),
    )).toBe(true);
  });
});
