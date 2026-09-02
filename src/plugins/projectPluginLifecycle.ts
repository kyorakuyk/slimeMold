/** A project identity used to guard asynchronous plugin lifecycle work. */
export interface ProjectPluginContext {
  projectId: string | null;
  projectPath: string | null;
}

export interface ProjectPluginTransition {
  previous: ProjectPluginContext | null;
  next: ProjectPluginContext;
  epoch: number;
}

function sameProjectContext(
  a: ProjectPluginContext | null,
  b: ProjectPluginContext,
): boolean {
  return a?.projectId === b.projectId && a?.projectPath === b.projectPath;
}

/**
 * Coalesce project changes and advance the epoch before running side effects.
 *
 * The callback is deferred so store writes made by teardown/logging cannot
 * synchronously re-enter the same lifecycle transition. A transition that is
 * superseded before the microtask runs is replaced by the latest context.
 */
export function createProjectPluginLifecycleScheduler(
  onTransition: (transition: ProjectPluginTransition) => void,
): {
  observe: (next: ProjectPluginContext) => void;
  isCurrent: (epoch: number, context: ProjectPluginContext) => boolean;
  dispose: () => void;
} {
  let current: ProjectPluginContext | null = null;
  let epoch = 0;
  let queued = false;
  let disposed = false;
  let pending: ProjectPluginTransition | null = null;

  const flush = (): void => {
    queued = false;
    if (disposed || !pending) return;
    const transition = pending;
    pending = null;
    onTransition(transition);
  };

  return {
    observe(next) {
      if (disposed || sameProjectContext(current, next)) return;
      const previous = current;
      current = next;
      epoch += 1;
      pending = pending
        ? { ...pending, next, epoch }
        : { previous, next, epoch };
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
    },
    isCurrent(candidateEpoch, context) {
      return (
        !disposed &&
        candidateEpoch === epoch &&
        current?.projectId === context.projectId &&
        current?.projectPath === context.projectPath
      );
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}

/** Decide whether project-scoped plugin registration must be rebuilt. */
export function shouldReloadProjectPlugins(
  previousProjectId: string | null,
  nextProjectId: string | null,
  previousProjectPath: string | null = null,
  nextProjectPath: string | null = null,
): boolean {
  return previousProjectId !== nextProjectId || previousProjectPath !== nextProjectPath;
}
