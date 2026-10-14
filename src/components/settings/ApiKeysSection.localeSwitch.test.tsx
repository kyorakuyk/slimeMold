import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';

vi.mock('../../platform/env', async (importActual) => {
  const actual = await importActual<typeof import('../../platform/env')>();
  return { ...actual, isTauri: false };
});

import ApiKeysSection from './ApiKeysSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ApiKeysSection locale switching', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage('zh-CN');
  });

  it('updates the web-only notice when the locale changes while the section is mounted', async () => {
    await act(async () => root.render(<ApiKeysSection />));
    expect(container.textContent).toContain(i18n.t('settings.apikeys.webOnly', { ns: 'settings', lng: 'zh-CN' }));

    await act(async () => i18n.changeLanguage('en-US'));

    expect(container.textContent).toContain(i18n.t('settings.apikeys.webOnly', { ns: 'settings', lng: 'en-US' }));
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
