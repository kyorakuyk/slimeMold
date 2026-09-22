/**
 * H4 Self-Development Policy：开发能力的安全边界（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §5）。
 *
 * - allowedPaths：允许开发节点读写的相对路径（目录前缀）；
 * - protectedPaths：触碰即要求人工 diff 审查的路径（且计入 DevAcceptance.changedProtectedPaths）；
 * - requireApprovalFor：需审批的能力类别；
 * - autoTest / autoCommit / autoPush：自动测试/提交/推送开关（autoPush 固定 false）。
 */
export interface SelfDevelopmentPolicy {
  allowedPaths: string[];
  protectedPaths: string[];
  requireApprovalFor: string[];
  autoTest: boolean;
  autoCommit: boolean;
  autoPush: boolean;
}

/** 初期配置（H4 文档 §5）：开发节点允许受控读取/执行 src/components、src/nodes、tests、docs、scripts。 */
export const defaultDevPolicy: SelfDevelopmentPolicy = {
  allowedPaths: ['src/components', 'src/nodes', 'tests', 'docs', 'scripts'],
  protectedPaths: [
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'scripts/**',
    'tests/**',
    'src/store/workflowStore.ts',
    'src/engine/executor.ts',
    'src/plugins/sandbox/**',
    'src-tauri/capabilities/**',
    'src/orchestrator/**',
  ],
  requireApprovalFor: ['store', 'executor', 'security', 'orchestrator', 'git-push'],
  autoTest: true,
  autoCommit: false,
  autoPush: false,
};

/** glob 片段转正则（仅支持 * 通配，** 在 matchesGlob 前缀语义中处理）。 */
function escapeReg(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * 相对路径是否匹配某个 pattern：
 * - `dir/**`：匹配 dir 自身及其下所有路径；
 * - 含 `*`：按单段通配匹配（* 不跨 /）；
 * - 其余：按路径前缀匹配（目录匹配其子路径）。
 */
export function matchesGlob(pattern: string, relPath: string): boolean {
  const pat = pattern.replace(/\\/g, '/');
  const p = relPath.replace(/\\/g, '/');
  if (pat.endsWith('/**')) {
    const base = pat.slice(0, -3);
    return p === base || p.startsWith(base + '/');
  }
  if (pat.includes('*')) {
    const re = new RegExp(`^${pat.split('*').map(escapeReg).join('[^/]*')}$`);
    return re.test(p);
  }
  return p === pat || p.startsWith(pat + '/');
}

/** 相对路径是否落在 allowedPaths 内（任一前缀命中即允许）。 */
export function isPathAllowed(policy: SelfDevelopmentPolicy, relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return policy.allowedPaths.some((a) => matchesGlob(a, p));
}

/** 相对路径是否命中 protectedPaths（任一命中即受保护）。 */
export function isPathProtected(policy: SelfDevelopmentPolicy, relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return policy.protectedPaths.some((a) => matchesGlob(a, p));
}

/** 断言路径允许：不在 allowedPaths 内或命中 protectedPaths 均抛错。 */
export function assertPathAllowed(policy: SelfDevelopmentPolicy, relPath: string): void {
  if (isPathProtected(policy, relPath)) {
    throw new Error(`路径受保护，禁止开发节点访问：${relPath}`);
  }
  if (!isPathAllowed(policy, relPath)) {
    throw new Error(`路径不在允许范围内（allowedPaths）：${relPath}`);
  }
}

/** 从变更文件清单中筛出触碰保护路径的文件（负向证据输入）。 */
export function collectChangedProtectedPaths(
  policy: SelfDevelopmentPolicy,
  changedFiles: string[],
): string[] {
  return changedFiles.filter((f) => isPathProtected(policy, f));
}
