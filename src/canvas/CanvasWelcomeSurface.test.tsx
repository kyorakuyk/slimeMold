import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import CanvasWelcomeSurface from './CanvasWelcomeSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CanvasWelcomeSurface starter-template locale', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage('zh-CN');
  });

  it('renders English names and descriptions for the welcome-page templates', async () => {
    await act(async () => {
      root.render(
        <CanvasWelcomeSurface
          welcomeDismissed={false}
          onDismiss={() => undefined}
          onShowWelcome={() => undefined}
          workflowCount={0}
        />,
      );
    });

    const firstTemplate = STARTER_TEMPLATES[0];
    const englishName = i18n.t(`starterTemplate.${firstTemplate.id}.name`, {
      ns: 'beginner',
      lng: 'en-US',
    });
    const englishDescription = i18n.t(`starterTemplate.${firstTemplate.id}.description`, {
      ns: 'beginner',
      lng: 'en-US',
    });
    expect(container.textContent).toContain(englishName);
    expect(container.textContent).toContain(englishDescription);
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
