import { describe, expect, it } from 'vitest';
import { createProjectDirtyController } from './projectDirtyController';

type TestState = {
  value: number;
  projectDirty: boolean;
  lastSavedSnapshot: string | null;
};

function createStore(initial: TestState) {
  let current = initial;
  const listeners = new Set<(next: TestState, previous: TestState) => void>();
  return {
    subscribe(listener: (next: TestState, previous: TestState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => current,
    setState(patch: Partial<TestState>) {
      const previous = current;
      current = { ...current, ...patch };
      for (const listener of listeners) listener(current, previous);
    },
    updateValue(value: number) {
      this.setState({ value });
    },
  };
}

describe('project dirty controller', () => {
  it('marks the project dirty when a tracked field changes', () => {
    const store = createStore({ value: 1, projectDirty: false, lastSavedSnapshot: '1' });
    createProjectDirtyController(store, {
      dirtyKeys: ['value'],
      snapshot: (state) => String(state.value),
    });

    store.updateValue(2);

    expect(store.getState().projectDirty).toBe(true);
  });

  it('suppresses tracking and finalizes a new stable baseline', () => {
    const store = createStore({ value: 1, projectDirty: false, lastSavedSnapshot: '1' });
    const controller = createProjectDirtyController(store, {
      dirtyKeys: ['value'],
      snapshot: (state) => String(state.value),
    });

    controller.setSuppressed(true);
    store.updateValue(2);
    expect(store.getState().projectDirty).toBe(false);

    controller.finalizeLoaded();
    expect(store.getState()).toMatchObject({ projectDirty: false, lastSavedSnapshot: '2' });
    expect(controller.isSuppressed()).toBe(false);
  });
});
