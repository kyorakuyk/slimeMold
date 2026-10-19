import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

const mocks = vi.hoisted(() => ({ status: 'unavailable' as 'unavailable' | 'error' }));

vi.mock('../dev/session', () => ({ getDevSession: () => null }));
vi.mock('../dev/gui', () => ({ getDevGuiStatus: () => mocks.status }));
vi.mock('../platform/env', () => ({ isTauri: true }));
vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: (selector: (state: { nodes: never[] }) => unknown) => selector({ nodes: [] }),
}));
vi.mock('../i18n/useT', () => ({ useT: () => (key: string) => key }));

import { DevSessionPanel } from './DevSessionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DevSessionPanel initialization status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.status = 'unavailable';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows expected non-Git unavailability as a neutral status', async () => {
    await act(async () => root.render(<DevSessionPanel />));

    expect(container.textContent).toContain('devSession.nonGitProject');
    expect(container.textContent).not.toContain('devSession.initializationFailed');
    expect(container.firstElementChild?.getAttribute('style')).not.toContain('--sm-err');
  });

  it('keeps unexpected initialization failures visibly error-level', async () => {
    mocks.status = 'error';
    await act(async () => root.render(<DevSessionPanel />));

    expect(container.textContent).toContain('devSession.initializationFailed');
    expect(container.textContent).toContain('devSession.retryHint');
    expect(container.firstElementChild?.getAttribute('style')).toContain('--sm-err');
  });

  it('uses generic initialization-failure copy for host and persistence errors', () => {
    const english = i18n.t('devSession.initializationFailed', { ns: 'panels', lng: 'en-US' });
    const chinese = i18n.t('devSession.initializationFailed', { ns: 'panels', lng: 'zh-CN' });

    expect(english).not.toContain('dev_init_session');
    expect(chinese).not.toContain('dev_init_session');
  });
});
