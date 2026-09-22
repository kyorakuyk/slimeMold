import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProjectConfigAutosave } from './projectConfigAutosave';

type TestState = {
  projectPath: string | null;
  agents: unknown[];
  roles: unknown[];
  defaultAgentId: string | null;
  agentRouteTable: Record<string, unknown>;
  saveProject: () => Promise<string>;
};

function createStore(initial: TestState) {
  let state = initial;
  const listeners = new Set<(next: TestState, previous: TestState) => void>();
  return {
    subscribe(listener: (next: TestState, previous: TestState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    update(patch: Partial<TestState>) {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, previous);
    },
  };
}

function state(saveProject: () => Promise<string>, projectPath: string | null = 'C:/project') {
  return {
    projectPath,
    agents: [],
    roles: [],
    defaultAgentId: null,
    agentRouteTable: {},
    saveProject,
  } satisfies TestState;
}

describe('project config autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces config changes into one project save', async () => {
    vi.useFakeTimers();
    const saveProject = vi.fn(async () => 'C:/project');
    const store = createStore(state(saveProject));
    const dispose = installProjectConfigAutosave(store, { isSuppressed: () => false });

    store.update({ agents: [{ id: 'agent-1' }] });
    store.update({ roles: [{ id: 'role-1' }] });
    await vi.advanceTimersByTimeAsync(999);
    expect(saveProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('does not schedule without a project or while suppressed', async () => {
    vi.useFakeTimers();
    const saveProject = vi.fn(async () => 'C:/project');
    let suppressed = false;
    const store = createStore(state(saveProject, null));
    const dispose = installProjectConfigAutosave(store, { isSuppressed: () => suppressed });

    store.update({ agents: [{ id: 'not-saved' }] });
    suppressed = true;
    store.update({ roles: [{ id: 'suppressed' }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveProject).not.toHaveBeenCalled();

    dispose();
  });
});
