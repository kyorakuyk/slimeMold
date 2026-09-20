const CONFIG_AUTO_SAVE_KEYS = ['agents', 'roles', 'defaultAgentId', 'agentRouteTable'] as const;

type ConfigAutoSaveKey = (typeof CONFIG_AUTO_SAVE_KEYS)[number];

export interface ProjectConfigAutosaveState {
  projectPath: string | null;
  agents: unknown;
  roles: unknown;
  defaultAgentId: unknown;
  agentRouteTable: unknown;
  saveProject: () => Promise<unknown>;
}

export interface ProjectConfigAutosaveStore<State extends ProjectConfigAutosaveState> {
  subscribe(listener: (state: State, previous: State) => void): () => void;
  getState(): State;
}

export interface ProjectConfigAutosaveOptions {
  isSuppressed: () => boolean;
  delayMs?: number;
}

export function installProjectConfigAutosave<State extends ProjectConfigAutosaveState>(
  store: ProjectConfigAutosaveStore<State>,
  options: ProjectConfigAutosaveOptions,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delayMs = options.delayMs ?? 1000;
  const unsubscribe = store.subscribe((state, previous) => {
    if (options.isSuppressed()) return;
    const changed = CONFIG_AUTO_SAVE_KEYS.some((key: ConfigAutoSaveKey) => state[key] !== previous[key]);
    if (!changed || !state.projectPath) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void store.getState().saveProject().catch(() => {});
    }, delayMs);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
