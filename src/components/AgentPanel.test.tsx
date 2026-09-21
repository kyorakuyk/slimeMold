import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types/agent';
import { useWorkflowStore } from '../store/workflowStore';

const mocks = vi.hoisted(() => ({
  fetchOllamaModels: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function resetWorkflowStore() {
  localStorage.removeItem('slime-mold-workflow');
  useWorkflowStore.setState({
    projectId: 'project-1',
    projectName: 'AgentPanel test project',
    projectPath: null,
    projectDirty: false,
    lastSavedSnapshot: null,
    agents: [{ ...baseAgent }],
    globalAgents: [],
    defaultAgentId: null,
    roles: [],
    agentRouteTable: {},
    logs: [],
  } as never);
}

describe('AgentPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetWorkflowStore();
    mocks.fetchOllamaModels.mockReset();
    mocks.fetchOllamaModels.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('slime-mold-workflow');
  });

  it('writes an edited agent field through the real catalog action', async () => {
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

    expect(useWorkflowStore.getState().agents[0]).toMatchObject({
      id: 'agent-1',
      name: '更新后的模型',
    });
    expect(container.textContent).toContain('更新后的模型');
  });

  it('surfaces Ollama model-pull failures and clears loading state', async () => {
    const pending = deferred<string[]>();
    mocks.fetchOllamaModels.mockReturnValueOnce(pending.promise);

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
    });
    expect(refreshButton.disabled).toBe(true);
    expect(mocks.fetchOllamaModels).toHaveBeenCalledWith(baseAgent.baseUrl);

    const failure = new Error('ollama unavailable');
    await act(async () => {
      pending.reject(failure);
      await pending.promise.catch(() => undefined);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('agent.model.pullFailed');
      expect(container.textContent).toContain('ollama unavailable');
      expect(refreshButton.disabled).toBe(false);
    });
  });

  it('preserves embedded and sidebar container contracts', async () => {
    await act(async () => {
      root.render(<AgentPanel embedded />);
    });

    const embeddedRoot = container.firstElementChild as HTMLDivElement;
    expect(embeddedRoot.className).toContain('h-full');
    expect(embeddedRoot.className).toContain('min-h-0');
    expect(embeddedRoot.className).toContain('flex-1');
    expect(embeddedRoot.className).toContain('flex-col');
    expect(container.querySelector('.fixed.inset-0')).toBeNull();

    await act(async () => {
      root.render(<AgentPanel variant="sidebar" />);
    });
    const sidebarLayout = Array.from(container.querySelectorAll('div')).find((element) =>
      element.className.includes('relative') && element.className.includes('overflow-visible'),
    );
    expect(sidebarLayout).toBeDefined();
    expect(container.querySelector('.absolute.left-full')).toBeNull();

    await act(async () => {
      (container.querySelector('ul li') as HTMLLIElement).click();
    });
    expect(container.querySelector('.absolute.left-full')).not.toBeNull();
  });
});
