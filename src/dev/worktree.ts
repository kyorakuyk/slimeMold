/**
 * H4 WorktreeManager（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §6）。
 *
 * 自举任务的隔离工作区：创建（带临时分支指向 HEAD）→ 保留到验收结束 → 人工确认后清理。
 * git 操作经注入的 DevGitRunner（Node 环境用 createNodeGitRunner 直接调系统 git；
 * Tauri 环境可注入复用 src/platform/git.ts 的 run_git 通道）。
 */
import type { CommandResult } from './node-run';
import { runCommand } from './node-run';

export interface DevGitRunner {
  git(args: string[], cwd: string): Promise<CommandResult>;
}

/** Node/headless git runner：直接调系统 git。 */
export function createNodeGitRunner(): DevGitRunner {
  return { git: (args, cwd) => runCommand('git', args, cwd) };
}

export type WorktreeStatus = 'created' | 'cleaned';

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

  /**
   * 创建 worktree：`git worktree add <path> -b <branch> HEAD`。
   * baseRepoPath 非 git 仓库或 git 不可用 → 返回 null（调用方应拒绝自举任务而非降级）。
   */
  async create(id: string, path: string, opts?: { branch?: string }): Promise<WorktreeInfo | null> {
    const rev = await this.runner.git(['rev-parse', 'HEAD'], this.baseRepoPath);
    if (rev.exitCode !== 0) return null;
    const baseRevision = rev.stdout.trim();
    const branch = opts?.branch ?? `dev-${id}-${Date.now().toString(36)}`;
    const add = await this.runner.git(['worktree', 'add', '-q', path, '-b', branch, 'HEAD'], this.baseRepoPath);
    if (add.exitCode !== 0) return null;
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

  list(): WorktreeInfo[] {
    return [...this.infos.values()];
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
  async cleanup(id: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const info = this.infos.get(id);
    if (!info || info.status === 'cleaned') return false;
    if (!opts.confirm) return false; // 确认门：未确认拒绝清理（防误删未提交改动）
    const rm = await this.runner.git(['worktree', 'remove', '--force', info.path], this.baseRepoPath);
    if (rm.exitCode !== 0) return false;
    await this.runner.git(['branch', '-D', info.branch], this.baseRepoPath);
    this.infos.set(id, { ...info, status: 'cleaned' });
    return true;
  }
}
