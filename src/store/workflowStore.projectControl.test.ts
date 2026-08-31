import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProjectControlSnapshot } from '../projectControl/persistence';
import { createProjectSession } from '../projectControl/state';
import { useWorkflowStore } from './workflowStore';

const session = createProjectSession({
  id: 'session-1',
  projectId: 'project-1',
  goal: '旧项目目标',
  now: '2026-08-31T03:00:00.000Z',
});

beforeEach(() => {
  useWorkflowStore.setState({
    projectName: '旧项目',
    projectId: 'project-1',
    projectControl: {
      version: 1,
      activeSessionId: session.id,
      sessions: [session],
      decisions: [],
      briefs: [],
    },
  } as never);
});

describe('workflowStore project control lifecycle', () => {
  it('normalizes project control snapshots at the store boundary', () => {
    useWorkflowStore.getState().setProjectControl({
      version: 1,
      activeSessionId: 'missing',
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });

    expect(useWorkflowStore.getState().projectControl.activeSessionId).toBeNull();
  });

  it('clears project control state when closing a project', () => {
    useWorkflowStore.getState().closeProject();

    expect(useWorkflowStore.getState().projectControl).toEqual(
      createEmptyProjectControlSnapshot(),
    );
  });
});
