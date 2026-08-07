import { isTauri } from '../platform/env';

export type GitWorktree = { cwd: string; path: string; branch: string };

export type RunResources = {
  sandboxRoots: Set<string>;
  gitWorktrees: GitWorktree[];
  worktree: GitWorktree | null;
};

const resourcesByRun = new Map<string, RunResources>();

export function resourceKey(wfId: string, runId: number): string {
  return `${wfId}:${runId}`;
}

export function createRunResources(wfId: string, runId: number): RunResources {
  const resources: RunResources = {
    sandboxRoots: new Set(),
    gitWorktrees: [],
    worktree: null,
  };
  resourcesByRun.set(resourceKey(wfId, runId), resources);
  return resources;
}

export function getRunResources(wfId: string, runId: number): RunResources | undefined {
  return resourcesByRun.get(resourceKey(wfId, runId));
}

/** 清理指定 run 创建的资源；旧 run 不会触碰新 run 的资源。 */
export async function cleanupRun(wfId: string, runId: number): Promise<void> {
  const key = resourceKey(wfId, runId);
  const resources = resourcesByRun.get(key);
  if (!resources) return;
  if (!isTauri) {
    resourcesByRun.delete(key);
    return;
  }

  const wts = resources.gitWorktrees;
  if (wts.length > 0) {
    try {
      const { removeWorktree } = await import('../platform/git');
      for (const wt of wts) {
        try {
          await removeWorktree(wt.cwd, wt.path, wt.branch);
        } catch {
          /* 忽略单条失败 */
        }
      }
    } catch {
      /* git 封装不可用：跳过 */
    }
    resources.gitWorktrees = [];
  }

  const roots = resources.sandboxRoots;
  if (!roots || roots.size === 0) {
    resourcesByRun.delete(key);
    return;
  }
  try {
    const fs = await import('@tauri-apps/plugin-fs');
    for (const base of roots) {
      try {
        await fs.remove(`${base}/.sandbox`, { recursive: true });
      } catch {
        // 目录不存在或已删：忽略
      }
    }
    roots.clear();
  } catch {
    // 整体清理失败：下次运行会重新登记
  } finally {
    resourcesByRun.delete(key);
  }
}
