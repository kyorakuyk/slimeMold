import { isTauri } from '../platform/env';
import { type EventStoreAdapter, type EventStoreLock } from './eventStore';

export type TauriInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

export interface TauriEventStoreDeps {
  invoke: TauriInvoke;
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

async function defaultDeps(): Promise<TauriEventStoreDeps> {
  const [{ invoke }, fs] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-fs'),
  ]);
  return {
    invoke: (command, args) => invoke(command, args),
    exists: (path) => fs.exists(path),
    readTextFile: (path) => fs.readTextFile(path),
    mkdir: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    writeTextFile: (path, text) => fs.writeTextFile(path, text),
    rename: (from, to) => fs.rename(from, to),
    remove: (path) => fs.remove(path),
  };
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function comparisonPath(path: string): string {
  const normalized = normalize(path);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function assertInsideRoot(root: string, path: string): void {
  const rootKey = comparisonPath(root);
  const pathKey = comparisonPath(path);
  if (pathKey !== rootKey && !pathKey.startsWith(`${rootKey}/`)) {
    throw new Error(`事件存储路径逃逸：${path}`);
  }
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? '.' : path.slice(0, index);
}

function relativeLockPath(root: string, path: string): string {
  const normalizedPath = normalize(path);
  const prefix = `${root}/`;
  const relative = normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
  if (!relative.startsWith('.slimemold/') || !relative.endsWith('.lock')) {
    throw new Error(`事件存储锁路径无效：${path}`);
  }
  return relative;
}

const localLockTails = new Map<string, Promise<void>>();

/**
 * Tauri adapter for the domain event store. The host owns the lock; plugin-fs
 * only performs scoped text I/O after the project directory is authorized.
 */
export function createTauriEventStoreAdapter(
  root: string,
  injectedDeps?: TauriEventStoreDeps,
): EventStoreAdapter {
  const normalizedRoot = normalize(root);
  if (!normalizedRoot) throw new Error('事件存储项目根目录不能为空');
  const depsPromise = injectedDeps ? Promise.resolve(injectedDeps) : defaultDeps();
  const injected = Boolean(injectedDeps);
  let accessPromise: Promise<void> | null = null;

  const getDeps = async (): Promise<TauriEventStoreDeps> => {
    if (!injected && !isTauri) {
      throw new Error('当前环境不是 Tauri，不能使用 Tauri 事件存储适配器');
    }
    return depsPromise;
  };
  const ensureAccess = async (deps: TauriEventStoreDeps): Promise<void> => {
    accessPromise ??= deps.invoke<void>('grant_project_access', { path: normalizedRoot });
    await accessPromise;
  };
  return {
    async readText(path: string): Promise<string | null> {
      assertInsideRoot(normalizedRoot, path);
      const deps = await getDeps();
      await ensureAccess(deps);
      if (!(await deps.exists(path))) return null;
      return deps.readTextFile(path);
    },

    async writeTextAtomic(path: string, text: string): Promise<void> {
      assertInsideRoot(normalizedRoot, path);
      const deps = await getDeps();
      await ensureAccess(deps);
      await deps.mkdir(dirname(path));
      const tmpPath = `${path}.tmp`;
      await deps.writeTextFile(tmpPath, text);
      try {
        await deps.rename(tmpPath, path);
      } catch (error) {
        try {
          await deps.remove(path);
          await deps.rename(tmpPath, path);
        } catch {
          // Preserve tmpPath for explicit repair/retry; never truncate-write.
          throw error;
        }
      }
    },

    async acquireLock(path: string): Promise<EventStoreLock> {
      assertInsideRoot(normalizedRoot, path);
      const lockRelativePath = relativeLockPath(normalizedRoot, path);
      const deps = await getDeps();
      await ensureAccess(deps);
      const lockKey = `${comparisonPath(normalizedRoot)}/${lockRelativePath}`;
      const previous = localLockTails.get(lockKey) ?? Promise.resolve();
      let releaseLocal!: () => void;
      const localTurn = new Promise<void>((resolve) => {
        releaseLocal = resolve;
      });
      const queued = previous.catch(() => {}).then(() => localTurn);
      localLockTails.set(lockKey, queued);
      await previous.catch(() => {});

      let token: string;
      try {
        token = await deps.invoke<string>('event_lock_acquire', {
          root: normalizedRoot,
          relativePath: lockRelativePath,
        });
      } catch (error) {
        releaseLocal();
        if (localLockTails.get(lockKey) === queued) localLockTails.delete(lockKey);
        throw error;
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await deps.invoke<void>('event_lock_release', {
              root: normalizedRoot,
              token,
              relativePath: lockRelativePath,
            });
          } finally {
            releaseLocal();
            if (localLockTails.get(lockKey) === queued) localLockTails.delete(lockKey);
          }
        },
      };
    },
  };
}
