import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';
import type { ApiVault } from '../types/agent';

const mocks = vi.hoisted(() => ({
  listEndpoints: vi.fn(),
  loadEndpointKey: vi.fn(),
  removeEndpoint: vi.fn(),
  listVaults: vi.fn(),
  loadVaultKey: vi.fn(),
  removeVault: vi.fn(),
  saveVault: vi.fn(),
  fetchModelsByProtocol: vi.fn(),
}));

vi.mock('../platform/env', async (importActual) => {
  const actual = await importActual<typeof import('../platform/env')>();
  return { ...actual, isTauri: true };
});

vi.mock('../agents/credentialStore', async (importActual) => {
  const actual = await importActual<typeof import('../agents/credentialStore')>();
  return {
    ...actual,
    listEndpoints: mocks.listEndpoints,
    loadEndpointKey: mocks.loadEndpointKey,
    removeEndpoint: mocks.removeEndpoint,
    listVaults: mocks.listVaults,
    loadVaultKey: mocks.loadVaultKey,
    removeVault: mocks.removeVault,
    saveVault: mocks.saveVault,
  };
});

vi.mock('../agents/agentManager', async (importActual) => {
  const actual = await importActual<typeof import('../agents/agentManager')>();
  return { ...actual, fetchModelsByProtocol: mocks.fetchModelsByProtocol };
});

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

import SettingsCenter from './SettingsCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeVault(): ApiVault {
  return {
    id: 'vault-test',
    label: 'Test provider',
    vendor: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.example.invalid/v1',
  };
}

describe('SettingsCenter characterization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem('slime-mold-workflow');
    localStorage.removeItem('sm.lastSession');
    useWorkflowStore.getState().setFailFast(true);
    useWorkflowStore.getState().setMaxConcurrency(3);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listEndpoints.mockReset().mockResolvedValue([]);
    mocks.loadEndpointKey.mockReset().mockResolvedValue(null);
    mocks.removeEndpoint.mockReset().mockResolvedValue(undefined);
    mocks.listVaults.mockReset().mockResolvedValue([]);
    mocks.loadVaultKey.mockReset().mockResolvedValue(null);
    mocks.removeVault.mockReset().mockResolvedValue(undefined);
    mocks.saveVault.mockReset();
    mocks.fetchModelsByProtocol.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('slime-mold-workflow');
    localStorage.removeItem('sm.lastSession');
  });

  it('opens on General and writes the Flow toggle through the real workflow store', async () => {
    await act(async () => {
      root.render(<SettingsCenter onClose={vi.fn()} />);
    });

    expect(container.textContent).toContain('settings.sec.general.label');
    const flowTab = Array.from(container.querySelectorAll('nav button')).find((button) =>
      button.textContent?.includes('settings.sec.flow.label'),
    ) as HTMLButtonElement;
    expect(flowTab).toBeDefined();
    await act(async () => flowTab.click());

    expect(container.textContent).toContain('settings.flow.failFast');
    expect(useWorkflowStore.getState().failFast).toBe(true);
    const failFastRow = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('settings.flow.failFast'),
    );
    const toggle = failFastRow?.querySelector('button') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => toggle.click());
    expect(useWorkflowStore.getState().failFast).toBe(false);
  });

  it('keeps dialog-surface mousedown inside and closes from the backdrop or Escape', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SettingsCenter onClose={onClose} />);
    });

    const backdrop = container.querySelector('.fixed.inset-0') as HTMLDivElement;
    const surface = backdrop.firstElementChild as HTMLDivElement;
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clears API-key recheck loading and shows an async verification error', async () => {
    const vault = makeVault();
    const pending = deferred<string[]>();
    mocks.listVaults.mockResolvedValue([vault]);
    mocks.loadVaultKey.mockResolvedValue({ apiKey: 'fixture-key', vault });
    mocks.fetchModelsByProtocol.mockReturnValueOnce(pending.promise);

    await act(async () => {
      root.render(<SettingsCenter onClose={vi.fn()} />);
    });
    const apiKeysTab = Array.from(container.querySelectorAll('nav button')).find((button) =>
      button.textContent?.includes('settings.sec.apikeys.label'),
    ) as HTMLButtonElement;
    await act(async () => apiKeysTab.click());

    const findRecheckButton = () => container.querySelector(
      'button[title="settings.apikeys.recheck"]',
    ) as HTMLButtonElement | null;
    await vi.waitFor(() => expect(findRecheckButton()).not.toBeNull());
    const recheckButton = findRecheckButton() as HTMLButtonElement;
    await act(async () => {
      recheckButton.click();
      await Promise.resolve();
    });

    expect(mocks.fetchModelsByProtocol).toHaveBeenCalledWith(
      'openai',
      vault.baseUrl,
      'fixture-key',
    );
    expect(recheckButton.disabled).toBe(true);
    expect(recheckButton.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');

    await act(async () => {
      pending.reject(new Error('fixture network failure'));
      await pending.promise.catch(() => undefined);
    });
    await vi.waitFor(() => {
      const currentButton = findRecheckButton() as HTMLButtonElement;
      expect(currentButton.disabled).toBe(false);
      expect(currentButton.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('animate-spin');
      expect(container.textContent).toContain('fixture network failure');
    });
    expect(mocks.saveVault).not.toHaveBeenCalled();
  });
});
