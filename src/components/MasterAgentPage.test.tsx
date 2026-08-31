import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types';
import type { ProjectControlSnapshot } from '../projectControl/types';

const mocks = vi.hoisted(() => {
  const projectControl: ProjectControlSnapshot = {
    version: 1,
    activeSessionId: 'session-1',
    masterAgentId: 'agent-1',
    sessions: [],
    decisions: [],
    briefs: [],
    architectures: [],
    issues: [],
  };
  const store = {
    projectName: '记账应用',
    projectControl,
    agents: [
      {
        id: 'agent-1',
        name: '本地主控',
        protocol: 'ollama' as const,
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5:3b',
        enabled: true,
      },
      {
        id: 'agent-2',
        name: '架构模型',
        protocol: 'openai' as const,
        baseUrl: 'https://api.example.com/v1',
        model: 'strong-model',
        enabled: true,
      },
    ],
    globalAgents: [] as AgentConfig[],
    setProjectControl: vi.fn((snapshot: ProjectControlSnapshot) => {
      store.projectControl = snapshot;
    }),
  };
  const viewStore = { globalMasterAgentId: null as string | null };
  return { store, viewStore };
});

vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

vi.mock('../store/viewStore', () => ({
  useViewStore: (selector: (state: typeof mocks.viewStore) => unknown) => selector(mocks.viewStore),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

import MasterAgentPage from './MasterAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MasterAgentPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      masterAgentId: 'agent-1',
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    };
    mocks.store.globalAgents = [];
    mocks.viewStore.globalMasterAgentId = null;
    mocks.store.setProjectControl.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows configured agents and the current master selection', async () => {
    await act(async () => {
      root.render(<MasterAgentPage onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    expect(container.querySelector('.sm-beginner-master-agent-main')).not.toBeNull();
    expect(container.textContent).toContain('本地主控');
    expect(container.textContent).toContain('架构模型');
    expect(container.querySelector('[aria-checked="true"]')).not.toBeNull();
  });

  it('saves a selected agent as masterAgentId only after explicit confirmation', async () => {
    await act(async () => {
      root.render(<MasterAgentPage onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    await act(async () => {
      (container.querySelector('[data-testid="master-agent-option-agent-2"]') as HTMLButtonElement).click();
    });
    expect(mocks.store.setProjectControl).not.toHaveBeenCalled();

    await act(async () => {
      (container.querySelector('[data-testid="master-agent-save"]') as HTMLButtonElement).click();
    });

    const calls = mocks.store.setProjectControl.mock.calls as unknown as Array<[ProjectControlSnapshot]>;
    expect(calls.at(-1)?.[0].masterAgentId).toBe('agent-2');
  });

  it('shows the global master when the project has no override', async () => {
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      masterAgentId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    };
    mocks.store.globalAgents = [
      {
        id: 'global-agent',
        name: '全局主控',
        protocol: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5:3b',
        enabled: true,
      },
    ];
    mocks.viewStore.globalMasterAgentId = 'global-agent';

    await act(async () => {
      root.render(<MasterAgentPage onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    expect(container.querySelector('[data-testid="master-agent-option-default"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('全局主控');
  });
});
