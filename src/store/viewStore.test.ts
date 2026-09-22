import { describe, expect, it } from 'vitest';
import { shouldRenderWelcomeModal, useViewStore, type TaskGraphSelection } from './viewStore';

describe('shouldRenderWelcomeModal', () => {
  it('does not render the legacy welcome overlay over the simple workspace', () => {
    expect(shouldRenderWelcomeModal('simple', true)).toBe(false);
  });

  it('keeps the legacy welcome overlay available in the advanced workspace', () => {
    expect(shouldRenderWelcomeModal('advanced', true)).toBe(true);
  });

  it('does not render when the welcome state is closed', () => {
    expect(shouldRenderWelcomeModal('advanced', false)).toBe(false);
  });

  it('stores and clears canonical TaskGraph selection for cross-view navigation', () => {
    const selection: TaskGraphSelection = {
      projectId: 'project-1',
      taskGraphId: 'graph-1',
      taskId: 'task-build',
      issueId: 'issue-build',
    };
    useViewStore.getState().setTaskGraphSelection(selection);
    expect(useViewStore.getState().taskGraphSelection).toEqual(selection);
    useViewStore.getState().clearTaskGraphSelection();
    expect(useViewStore.getState().taskGraphSelection).toBeNull();
  });
});
