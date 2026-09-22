export interface ProjectDirtyState {
  projectDirty: boolean;
  lastSavedSnapshot: string | null;
}

export interface ProjectDirtyStore<State extends ProjectDirtyState> {
  subscribe(listener: (state: State, previous: State) => void): () => void;
  getState(): State;
  setState(patch: Partial<State>): void;
}

export interface ProjectDirtyController {
  setSuppressed(value: boolean): void;
  isSuppressed(): boolean;
  finalizeLoaded(): void;
  dispose(): void;
}

export function createProjectDirtyController<State extends ProjectDirtyState>(
  store: ProjectDirtyStore<State>,
  options: {
    dirtyKeys: readonly (keyof State)[];
    snapshot: (state: State) => string;
  },
): ProjectDirtyController {
  let suppressed = false;
  const unsubscribe = store.subscribe((state, previous) => {
    if (suppressed) return;
    if (options.dirtyKeys.every((key) => state[key] === previous[key])) return;
    if (!state.lastSavedSnapshot) {
      if (!state.projectDirty) store.setState({ projectDirty: true } as Partial<State>);
      return;
    }
    if (state.lastSavedSnapshot !== options.snapshot(state) && !state.projectDirty) {
      store.setState({ projectDirty: true } as Partial<State>);
    }
  });

  return {
    setSuppressed(value) {
      suppressed = value;
    },
    isSuppressed() {
      return suppressed;
    },
    finalizeLoaded() {
      suppressed = false;
      store.setState({
        projectDirty: false,
        lastSavedSnapshot: options.snapshot(store.getState()),
      } as Partial<State>);
    },
    dispose() {
      unsubscribe();
    },
  };
}
