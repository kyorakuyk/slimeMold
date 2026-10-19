import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import type { ApiVault } from '../../types/agent';

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

vi.mock('../../platform/env', async (importActual) => {
  const actual = await importActual<typeof import('../../platform/env')>();
  return { ...actual, isTauri: true };
});

vi.mock('../../agents/credentialStore', async (importActual) => {
  const actual = await importActual<typeof import('../../agents/credentialStore')>();
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

vi.mock('../../agents/agentManager', async (importActual) => {
  const actual = await importActual<typeof import('../../agents/agentManager')>();
  return { ...actual, fetchModelsByProtocol: mocks.fetchModelsByProtocol };
});

import ApiKeysSection from './ApiKeysSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vault: ApiVault = {
  id: 'fixture-vault',
  label: 'Fixture provider',
  vendor: 'deepseek',
  protocol: 'openai',
  baseUrl: 'https://api.example.invalid/v1',
};

describe('ApiKeysSection English locale regression', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listEndpoints.mockReset().mockResolvedValue([]);
    mocks.loadEndpointKey.mockReset().mockResolvedValue(null);
    mocks.removeEndpoint.mockReset().mockResolvedValue(undefined);
    mocks.listVaults.mockReset().mockResolvedValue([]);
    mocks.loadVaultKey.mockReset().mockResolvedValue(null);
    mocks.removeVault.mockReset().mockResolvedValue(undefined);
    mocks.saveVault.mockReset().mockResolvedValue(undefined);
    mocks.fetchModelsByProtocol.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage('zh-CN');
  });

  it('localizes the vendor preview, domain suggestion, and validation failures', async () => {
    mocks.listVaults.mockResolvedValue([vault]);
    await act(async () => root.render(<ApiKeysSection />));

    const baseUrl = Array.from(container.querySelectorAll('input')).find((input) =>
      input.placeholder.startsWith('API URL'),
    ) as HTMLInputElement | undefined;
    expect(baseUrl).toBeDefined();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(baseUrl, 'https://api.deepseek.com/v1');
    await act(async () => baseUrl?.dispatchEvent(new Event('input', { bubbles: true })));

    const autoGroup = i18n.t('settings.apikeys.autoGroup', { ns: 'settings', lng: 'en-US' });
    const domainSuggestion = i18n.t('settings.apikeys.nameFromDomain', {
      ns: 'settings',
      lng: 'en-US',
      domain: 'api.deepseek.com',
    });
    expect(container.textContent).toContain(autoGroup);
    expect(container.textContent).toContain(domainSuggestion);

    const recheckTitle = i18n.t('settings.apikeys.recheck', { ns: 'settings', lng: 'en-US' });
    const recheck = container.querySelector(`button[title="${recheckTitle}"]`) as HTMLButtonElement;
    await act(async () => recheck.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        i18n.t('settings.apikeys.missingKey', { ns: 'settings', lng: 'en-US' }),
      );
    });
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(mocks.fetchModelsByProtocol).not.toHaveBeenCalled();
  });

  it('localizes legacy migration feedback and the no-models validation message', async () => {
    await i18n.changeLanguage('zh-CN');
    mocks.listEndpoints.mockResolvedValue([
      { name: 'legacy-endpoint', baseUrl: 'https://api.example.invalid/v1', protocol: 'openai', credentialKey: 'legacy-key' },
    ]);
    mocks.loadEndpointKey.mockResolvedValue('fixture-key');
    mocks.listVaults.mockResolvedValue([vault]);
    mocks.loadVaultKey.mockResolvedValue({ apiKey: 'fixture-key' });
    mocks.fetchModelsByProtocol.mockResolvedValue([]);

    await act(async () => root.render(<ApiKeysSection />));
    const zhMigrationMessage = i18n.t('settings.apikeys.migrationSuccess', {
      ns: 'settings',
      lng: 'zh-CN',
      count: 1,
    });
    await vi.waitFor(() => expect(container.textContent).toContain(zhMigrationMessage));

    const recheckTitle = i18n.t('settings.apikeys.recheck', { ns: 'settings', lng: 'zh-CN' });
    const recheck = container.querySelector(`button[title="${recheckTitle}"]`) as HTMLButtonElement;
    await act(async () => recheck.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        i18n.t('settings.apikeys.noModels', { ns: 'settings', lng: 'zh-CN' }),
      );
    });

    await act(async () => i18n.changeLanguage('en-US'));
    expect(container.textContent).toContain(i18n.t('settings.apikeys.migrationSuccess', {
      ns: 'settings',
      lng: 'en-US',
      count: 1,
    }));
    expect(container.textContent).toContain(
      i18n.t('settings.apikeys.noModels', { ns: 'settings', lng: 'en-US' }),
    );
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
