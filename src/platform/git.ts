// 步骤 11 阶段 C：Git Worktree 真隔离的前端封装。
// 所有 git 操作经 Rust 侧 `run_git` command（std::process::Command 调系统 git），
// 不受 Tauri 沙箱限制；浏览器环境无 invoke 通道，自动判否。
import { isTauri } from './env';

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  if (!isTauri) return { stdout: '', stderr: '浏览器环境不支持 git', code: -1 };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke('run_git', { args, cwd: cwd ?? null })) as GitResult;
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1 };
  }
}

/** 当前目录是否为 git 仓库（且 git 可用）。 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** 创建一个带临时分支的 git worktree 指向 HEAD，返回其路径。失败返回 null（调用方降级到 copy 沙箱）。 */
export async function addWorktree(cwd: string, path: string, branch: string): Promise<string | null> {
  // Legacy lane is intentionally read-only. H4 Worker worktrees must go through
  // WorktreeManager/dev_exec so the host can bind path, branch, and AttemptId.
  void cwd;
  void path;
  void branch;
  return null;
}

/** 移除 worktree 并清理分支（force 以丢弃未提交改动）。 */
export async function removeWorktree(cwd: string, path: string, branch: string): Promise<void> {
  // No legacy worktree can be created after addWorktree became read-only.
  // Keep the API for callers compiled against the old executor; cleanup is
  // performed by the registered H4 WorktreeManager path.
  void cwd;
  void path;
  void branch;
}
