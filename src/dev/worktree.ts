/**
 * H4 WorktreeManager（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §6）。
 *
 * 自举任务的隔离工作区：创建（带临时分支指向 HEAD）→ 保留到验收结束 → 人工确认后清理。
 * git 操作经注入的 DevGitRunner（Node 环境用 createNodeGitRunner 直接调系统 git；
 * Tauri 环境可注入复用 src/platform/git.ts 的 run_git 通道）。
 */
import type { CommandResult } from './node-run';
import { runCommand } from './node-run';
import { normalizeAbsolutePath, pathComparisonKey } from './path-utils';
import { WORKER_IDENTITY_MAX_LENGTH } from '../domain/execution';

export interface DevGitRunner {
  git(args: string[], cwd: string): Promise<CommandResult>;
}

/** Node/headless git runner：直接调系统 git。 */
export function createNodeGitRunner(): DevGitRunner {
  return { git: (args, cwd) => runCommand('git', args, cwd) };
}

export type WorktreeStatus = 'created' | 'cleaned' | 'orphaned' | 'registration-pending';

function branchStem(id: string): string {
  const stem = id
    .replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return stem || 'worktree';
}

/** Rust/Tauri worktree registration uses the target basename as its branch identity. */
export function workerBranchForPath(path: string): string {
  const basename = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (
    !/^[A-Za-z0-9._-]+$/.test(basename)
    || basename.length > WORKER_IDENTITY_MAX_LENGTH
    || basename.startsWith('.')
    || basename.endsWith('.')
    || basename.includes('..')
    || basename.toLowerCase().endsWith('.lock')
  ) {
    throw new Error(`Worker worktree basename 无效：${path}`);
  }
  return `worker/${basename}`;
}

export interface WorktreeInfo {
  id: string;
  /** worktree 绝对路径（Agent 可写区） */
  path: string;
  branch: string;
  baseRevision: string;
  createdAt: string;
  status: WorktreeStatus;
}

export class WorktreeManager {
  private infos = new Map<string, WorktreeInfo>();

  constructor(
    private readonly runner: DevGitRunner,
    private readonly baseRepoPath: string,
  ) {}

  getBaseRepoPath(): string {
    return this.baseRepoPath;
  }

  /**
   * 创建 worktree：`git worktree add <path> -b <branch> HEAD`。
   * baseRepoPath 非 git 仓库或 git 不可用 → 返回 null（调用方应拒绝自举任务而非降级）。
   */
  async create(id: string, path: string, opts?: { branch?: string; signal?: AbortSignal }): Promise<WorktreeInfo | null> {
    if (opts?.signal?.aborted) return null;
    const rev = await this.runner.git(['rev-parse', 'HEAD'], this.baseRepoPath);
    if (rev.exitCode !== 0) return null;
    if (opts?.signal?.aborted) return null;
    const baseRevision = rev.stdout.trim();
    const branch = opts?.branch ?? `dev-${branchStem(id)}-${Date.now().toString(36)}`;
    const add = await this.runner.git(['worktree', 'add', '-q', path, '-b', branch, 'HEAD'], this.baseRepoPath);
    if (add.exitCode !== 0) return null;
    if (opts?.signal?.aborted) {
      await this.runner.git(['worktree', 'remove', '--force', path], this.baseRepoPath);
      await this.runner.git(['branch', '-D', branch], this.baseRepoPath);
      return null;
    }
    const info: WorktreeInfo = {
      id,
      path,
      branch,
      baseRevision,
      createdAt: new Date().toISOString(),
      status: 'created',
    };
    this.infos.set(id, info);
    return info;
  }

  get(id: string): WorktreeInfo | undefined {
    return this.infos.get(id);
  }

  /** 按规范化后的 worktree 路径查找仍在使用中的登记。 */
  getByPath(path: string): WorktreeInfo | undefined {
    const normalized = pathComparisonKey(path);
    return [...this.infos.values()].find(
      (info) => info.status === 'created' && pathComparisonKey(info.path) === normalized,
    );
  }

  /**
   * Restore a worktree after a process restart only when git still reports it as live.
   * ProjectFile metadata is treated as a hint; the host's git worktree list is authoritative.
   */
  async restore(info: WorktreeInfo, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (opts.signal?.aborted) return false;
    if (info.status !== 'created') return false;
    const path = normalizeAbsolutePath(info.path);
    const base = normalizeAbsolutePath(this.baseRepoPath);
    if (pathComparisonKey(path) === pathComparisonKey(base)) return false;

    const existing = this.infos.get(info.id);
    if (existing) return pathComparisonKey(existing.path) === pathComparisonKey(path) && existing.status === 'created';
    const pathConflict = this.list().find(
      (item) => item.status === 'created' && pathComparisonKey(item.path) === pathComparisonKey(path),
    );
    if (pathConflict) return false;

    const listed = await this.runner.git(['worktree', 'list', '--porcelain'], this.baseRepoPath);
    if (listed.exitCode !== 0) return false;
    if (opts.signal?.aborted) return false;
    const blocks = listed.stdout.split(/\n\s*\n/);
    const live = blocks.some((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      return (
        !!worktreeLine &&
        pathComparisonKey(worktreeLine.slice('worktree '.length)) === pathComparisonKey(path) &&
        branchLine === `branch refs/heads/${info.branch}`
      );
    });
    if (!live) return false;

    this.infos.set(info.id, { ...info, path, status: 'created' });
    return true;
  }

  list(): WorktreeInfo[] {
    return [...this.infos.values()];
  }

  /**
   * 路径是否为已登记且未清理的 worktree。
   * 统一经 path.resolve 规范化比较（解析 . / ..、Windows 分隔符）——审计修复：
   * 避免不同路径表示导致合法 worktree 被拒，或折返路径（worktree2/../worktree）绕过。
   */
  isTracked(path: string): boolean {
    const p = pathComparisonKey(path);
    return [...this.infos.values()].some(
      (i) => i.status === 'created' && pathComparisonKey(i.path) === p,
    );
  }

  forget(id: string): void {
    this.infos.delete(id);
  }

  markRegistrationPending(id: string): void {
    const info = this.infos.get(id);
    if (info?.status === 'cleaned') this.infos.set(id, { ...info, status: 'registration-pending' });
  }

  markCleaned(id: string): void {
    const info = this.infos.get(id);
    if (info?.status === 'registration-pending') this.infos.set(id, { ...info, status: 'cleaned' });
  }

  /** P0 审计：cwd 必须属于已登记 worktree，否则抛错（防指向主仓库/任意目录绕过）。 */
  assertTracked(path: string): void {
    if (!this.isTracked(path)) {
      throw new Error(`工作目录不属于任何已登记的 worktree：${path}`);
    }
  }

  /** worktree 是否还有未提交改动（tracked diff 或 untracked 文件）。 */
  async hasUncommittedChanges(id: string): Promise<boolean> {
    const info = this.infos.get(id);
    if (!info || info.status === 'cleaned') return false;
    const [diffQ, untracked] = await Promise.all([
      this.runner.git(['diff', '--quiet', 'HEAD'], info.path),
      this.runner.git(['ls-files', '--others', '--exclude-standard'], info.path),
    ]);
    return diffQ.exitCode !== 0 || untracked.stdout.trim().length > 0;
  }

  /**
   * 清理 worktree 并删除临时分支。
   * 确认门（审计修复）：必须显式传入 { confirm: true }（由上层在人工验收后调用）——
   * `git worktree remove --force` 会丢弃未提交改动，未确认一律拒绝清理（返回 false）。
   * 失败返回 false（保留现场供回放）。
   */
  async cleanup(id: string, opts: { confirm?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    const info = this.infos.get(id);
    if (!info || info.status === 'cleaned') return false;
    if (!opts.confirm) return false; // 确认门：未确认拒绝清理（防误删未提交改动）
    if (opts.signal?.aborted) return false;
    if (info.status === 'registration-pending') return true;
    if (info.status === 'orphaned') {
      const branch = await this.runner.git(['branch', '-D', info.branch], this.baseRepoPath);
      if (branch.exitCode !== 0) return false;
      this.infos.set(id, { ...info, status: 'cleaned' });
      return true;
    }
    const rm = await this.runner.git(['worktree', 'remove', '--force', info.path], this.baseRepoPath);
    if (rm.exitCode !== 0) return false;
    // remove 已经发生后必须完成分支收尾，不能因取消留下假 created 状态。
    const branch = await this.runner.git(['branch', '-D', info.branch], this.baseRepoPath);
    if (branch.exitCode !== 0) {
      this.infos.set(id, { ...info, status: 'orphaned' });
      return false;
    }
    this.infos.set(id, { ...info, status: 'cleaned' });
    return true;
  }
}
