import type { CommandResult } from './node-run';
import type { WorktreePathVerifier } from './worktree';
import { pathComparisonKey } from './path-utils';

type GitReadback = {
  git(args: string[], cwd: string): Promise<CommandResult>;
};

export type FailedWorktreeAddReadback =
  | { status: 'none' }
  | { status: 'orphaned'; branchRevision: string }
  | { status: 'registration-pending'; branchRevision?: string };

function parseWorktreeEntries(stdout: string): Array<{ path: string; branch?: string }> | null {
  const blocks = stdout.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  if (!blocks.length) return null;
  const entries = blocks.map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) return null;
    return {
      path,
      branch: lines.find((line) => line.startsWith('branch '))?.slice('branch '.length),
    };
  });
  return entries.every((entry) => entry !== null)
    ? entries as Array<{ path: string; branch?: string }>
    : null;
}

export async function inspectFailedWorktreeAdd(
  runner: GitReadback,
  baseRepoPath: string,
  path: string,
  branch: string,
  verifyPathIdentity?: WorktreePathVerifier,
): Promise<FailedWorktreeAddReadback> {
  const pending = (branchRevision?: string): FailedWorktreeAddReadback => ({
    status: 'registration-pending',
    ...(branchRevision ? { branchRevision } : {}),
  });
  try {
    const [listed, branchProbe] = await Promise.all([
      runner.git(['worktree', 'list', '--porcelain'], baseRepoPath),
      runner.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], baseRepoPath),
    ]);
    if (
      listed.exitCode !== 0 || listed.unknownEffects || branchProbe.unknownEffects
      || ![0, 1].includes(branchProbe.exitCode)
      || (branchProbe.exitCode === 1 && (branchProbe.stdout.trim() || branchProbe.stderr.trim()))
    ) return pending();
    const entries = parseWorktreeEntries(listed.stdout);
    if (!entries) return pending();

    let branchRevision: string | undefined;
    if (branchProbe.exitCode === 0) {
      const revision = await runner.git(
        ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`],
        baseRepoPath,
      );
      const candidate = revision.stdout.trim();
      if (
        revision.exitCode !== 0 || revision.unknownEffects
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(candidate)
      ) return pending();
      branchRevision = candidate;
    }

    const targetAbsent = !verifyPathIdentity || await verifyPathIdentity(path, false);
    const referenced = entries.some((entry) =>
      pathComparisonKey(entry.path) === pathComparisonKey(path)
      || entry.branch === `refs/heads/${branch}`,
    );
    if (referenced || !targetAbsent) return pending(branchRevision);
    return branchRevision ? { status: 'orphaned', branchRevision } : { status: 'none' };
  } catch {
    return pending();
  }
}
