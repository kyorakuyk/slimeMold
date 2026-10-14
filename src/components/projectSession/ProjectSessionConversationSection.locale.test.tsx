import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ProjectSessionConversationSection from './ProjectSessionConversationSection';
import type {
  ProjectSessionPanelViewProps,
  ProjectSessionViewTranslator,
} from './ProjectSessionPanelView.types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = { messages: [] } as unknown as ProjectSessionPanelViewProps['session'];

const cases = [
  [
    '项目必须先保存，Worker 才能创建隔离 worktree',
    'session.error.workerProjectNotSaved',
    'Save the project before starting a Worker.',
  ],
  [
    'Worker post-commit project context 已切换，拒绝执行旧 recovery dispatch',
    'session.error.workerProjectChanged',
    'Project context changed; the prior recovery dispatch was rejected.',
  ],
  [
    'Worker post-commit candidate/state 已漂移，拒绝执行旧 recovery dispatch',
    'session.error.workerStateDrifted',
    'Worker state changed; the prior recovery dispatch was rejected.',
  ],
] as const;

describe('ProjectSessionConversationSection error localization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(cases)('localizes the Worker error payload for display', async (error, key, expected) => {
    const t = ((candidate: string) => candidate === key ? expected : candidate) as unknown as ProjectSessionViewTranslator;
    await act(async () => {
      root.render(
        <ProjectSessionConversationSection
          session={session}
          busy={false}
          streamingText=""
          localResponse={null}
          localReplyVisible={false}
          visibleQuestions={[]}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          error={error}
          t={t}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
  });
});
