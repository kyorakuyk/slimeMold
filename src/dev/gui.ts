/**
 * H4 GUI（Tauri）生命周期桥接（Phase 1）：
 * - 打开项目时初始化 DevSession（env='tauri'，命令/文件走 Rust 通道）；
 * - 把 dev.* 节点定义注册进 registryStore（executor 通过 registry 解析执行）；
 * - 把主仓库根同步到 Rust 宿主（dev_init_session）；
 * - 关闭/切换项目时卸载 dev 节点定义并重置 session（防旧 session 污染其它项目）。
 *
 * 安全边界：仅 Tauri 下生效（浏览器预览不初始化，dev 节点保持不可用）。
 */
import { isTauri } from '../platform/env';
import { initDevSession, resetDevSession, getDevSession } from './session';
import { useRegistryStore } from '../store/registryStore';

/** dev.* 节点 typeId 集合（teardown 时从 registry 精确移除）。 */
const DEV_TYPE_IDS = [
  'dev.worktree.create',
  'dev.worktree.status',
  'dev.worktree.cleanup',
  'dev.code.read',
  'dev.code.patch',
  'dev.shell.run',
  'dev.test.run',
  'dev.git.status',
  'dev.git.diff',
  'dev.evidence.add',
  'dev.accept',
];

/** 宿主固定证据根：`<项目根>/.slimemold/evidence`（位于 worktree 外；worktree 创建时动态绑定）。 */
function evidenceRootFor(projectPath: string): string {
  return `${projectPath.replace(/[/\\]+$/, '')}/.slimemold/evidence`;
}

/**
 * 确保 GUI 下 DevSession 就绪（Tauri + 项目已打开）。
 * 返回 session；非 Tauri 或未打开项目返回 null。
 */
export function ensureGuiDevSession(projectPath: string | null): ReturnType<typeof getDevSession> {
  if (!isTauri) return null;
  if (!projectPath) return null;
  const existing = getDevSession();
  if (existing) return existing;

  const session = initDevSession({
    baseRepoPath: projectPath,
    env: 'tauri',
    evidenceRoot: evidenceRootFor(projectPath),
  });
  // 注册 dev 节点定义（executor 经 registry 解析，与 headless buildDefs 同源）
  useRegistryStore.getState().register(session.defs);
  // 同步 Rust 宿主登记态（dev_exec 的 cwd 归属校验依赖主仓库根）
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('dev_init_session', { baseRepo: projectPath }))
    .catch(() => {});
  return session;
}

/** 卸载 GUI DevSession：移除 dev 节点定义 + 重置单例（切换/关闭项目时调用）。 */
export function teardownGuiDevSession(): void {
  const session = getDevSession();
  const typeIds = new Set(
    DEV_TYPE_IDS.filter((id) => useRegistryStore.getState().defs[id]),
  );
  if (session) {
    for (const d of session.defs) typeIds.add(d.typeId);
  }
  resetDevSession();
  if (typeIds.size > 0) {
    useRegistryStore.setState((s) => {
      const defs = { ...s.defs };
      for (const id of typeIds) delete defs[id];
      return { defs };
    });
  }
}
