export interface ProjectSaveQueue {
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createProjectSaveQueue(): ProjectSaveQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue: <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.catch(() => {}).then(() => current);
      tails.set(key, queued);

      const result = previous.catch(() => {}).then(task);
      return result.finally(() => {
        release();
        if (tails.get(key) === queued) tails.delete(key);
      });
    },
  };
}
