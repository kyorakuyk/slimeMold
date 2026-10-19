import type { EvidenceCollector } from './evidence';
import type { WorktreeManager } from './worktree';

export type SessionRustSync = (
  fn: 'register' | 'restore' | 'register-orphan' | 'unregister',
  path: string,
  branch?: string,
  branchRevision?: string,
  targetIdentity?: string,
) => Promise<string | undefined>;

export function installSessionWorktreeLifecycle(input: {
  env: 'node' | 'tauri';
  manager: WorktreeManager;
  collector: EvidenceCollector;
  evidenceRoot?: string;
  syncRust: SessionRustSync;
}): void {
  const { env, manager, collector, evidenceRoot, syncRust } = input;
  const registeredWorktrees = new Set<string>();
  const rawCreate = manager.create.bind(manager);
  const rawRestore = manager.restore.bind(manager);
  const rawCleanup = manager.cleanup.bind(manager);

  manager.create = async (id, path, opts) => {
    const previousInfo = manager.get(id);
    const info = await rawCreate(id, path, opts);
    const failedInfo = manager.get(id);
    if (
      !info
      && env === 'tauri'
      && failedInfo !== previousInfo
      && failedInfo?.status === 'orphaned'
      && failedInfo.branchRevision?.trim()
    ) {
      // Git read-back proved a branch-only orphan. The native host rechecks
      // target absence and branch CAS before accepting the repair fact.
      await syncRust('register-orphan', failedInfo.path, failedInfo.branch, failedInfo.branchRevision);
    }
    if (!info) return info;

    if (env === 'tauri' && evidenceRoot) {
      const { createTauriEvidenceStore } = await import('./tauri-run');
      try {
        collector.attachPersistence(createTauriEvidenceStore(evidenceRoot, info.path, 'host'));
      } catch {
        // An intersecting evidence root disables durable evidence and cleanup.
      }
    }
    try {
      const targetIdentity = await syncRust('register', info.path);
      if (env === 'tauri' && !targetIdentity) {
        await syncRust('unregister', info.path).catch(() => undefined);
        throw new Error('native worktree registration missing stable target identity');
      }
      const registeredInfo = targetIdentity
        ? manager.bindTargetIdentity(info.id, targetIdentity) ?? info
        : info;
      registeredWorktrees.add(info.id);
      return registeredInfo;
    } catch (error) {
      const rolledBack = await rawCleanup(id, { confirm: true, signal: opts?.signal }).catch(() => false);
      if (rolledBack) manager.forget(id);
      throw error;
    }
  };

  manager.restore = async (info, opts) => {
    const restored = await rawRestore(info, opts);
    if (!restored) return false;
    if (info.status === 'registration-pending') return true;
    if (info.status === 'orphaned') {
      try {
        await syncRust('register-orphan', info.path, info.branch, info.branchRevision);
        return true;
      } catch {
        return false;
      }
    }
    try {
      await syncRust('restore', info.path, info.branch, undefined, info.targetIdentity);
      registeredWorktrees.add(info.id);
      return true;
    } catch {
      return false;
    }
  };

  manager.cleanup = async (id, opts) => {
    const info = manager.get(id);
    if (info?.status === 'registration-pending') {
      if (!opts?.confirm
        || opts?.signal?.aborted
        || !info.targetIdentity?.trim()
        || !info.branchRevision?.trim()) return false;
      try {
        await syncRust('unregister', info.path);
        registeredWorktrees.delete(id);
        manager.markCleaned(id);
        return true;
      } catch {
        return false;
      }
    }
    const cleaned = await rawCleanup(id, opts);
    if (!cleaned || !info) return cleaned;
    if (!registeredWorktrees.has(id)) {
      manager.forget(id);
      return true;
    }
    try {
      await syncRust('unregister', info.path);
      registeredWorktrees.delete(id);
    } catch {
      manager.markRegistrationPending(id);
      return false;
    }
    return cleaned;
  };
}
