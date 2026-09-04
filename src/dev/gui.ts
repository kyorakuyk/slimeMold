/**
 * H4 GUI（Tauri）生命周期桥接（Phase 1 + 审计 P1 修复）：
 * - 打开项目时**先**同步 Rust 宿主登记态（await dev_init_session 成功），**之后才**注册 dev.*
 *   节点定义并初始化 DevSession——避免「前端已注册但宿主未就绪」的窗口期；
 * - 切换/关闭项目时先 `dev_clear_session` 清空旧登记态再 teardown（防旧项目登记泄漏到新项目）；
 * - 初始化失败不静默吞掉：暴露 `devGuiStatus`（'idle'|'ready'|'unavailable'），
 *   面板据此显示「开发能力不可用」。
 *
 * 安全边界：仅 Tauri 下生效（浏览器预览不初始化，dev 节点保持不可用）。
 */
import { isTauri } from '../platform/env';
import { initDevSession, resetDevSession, getDevSession, createHostAcceptanceStoreWithFs } from './session';
import { useRegistryStore } from '../store/registryStore';
import { pathComparisonKey } from './path-utils';
import type { NodeDefinition } from '../types';

/** dev.* 节点 typeId 集合（teardown 时从 registry 精确移除）。 */
const DEV_TYPE_IDS = [
  'dev.worktree.create',
  'dev.worktree.status',
  'dev.worktree.cleanup',
  'dev.code.read',
  'dev.code.patch',
  'dev.patch.apply',
  'dev.shell.run',
  'dev.test.run',
  'dev.git.status',
  'dev.git.diff',
  'dev.evidence.add',
  'dev.accept',
];

/** GUI DevSession 就绪状态（审计 P1：初始化失败须显式可见，不静默吞异常）。 */
export type DevGuiStatus = 'idle' | 'ready' | 'unavailable';
let devGuiStatus: DevGuiStatus = 'idle';
let devSessionGeneration = 0;
export function getDevGuiStatus(): DevGuiStatus {
  return devGuiStatus;
}
export function setDevGuiStatus(s: DevGuiStatus): void {
  devGuiStatus = s;
}

export function registerGuiDevDefs(defs: NodeDefinition[]): void {
  useRegistryStore.getState().register(defs);
}

/** 宿主固定证据根：`<项目根>/.slimemold/evidence`（位于 worktree 外；worktree 创建时动态绑定）。 */
function evidenceRootFor(projectPath: string): string {
  return `${projectPath.replace(/[/\\]+$/, '')}/.slimemold/evidence`;
}

/**
 * 确保 GUI 下 DevSession 就绪（Tauri + 项目已打开）。
 * **同步链路**：await dev_init_session 成功 → 初始化 DevSession → 注册 dev.* 定义 → status=ready。
 * 失败 → status=unavailable，不注册 dev 节点（fail-closed），返回 null。
 */
export async function ensureGuiDevSession(projectPath: string | null, signal?: AbortSignal): Promise<ReturnType<typeof getDevSession>> {
  if (!isTauri) return null;
  if (!projectPath) return null;
  if (signal?.aborted) return null;
  const existing = getDevSession();
  if (existing) {
    if (pathComparisonKey(existing.manager.getBaseRepoPath()) !== pathComparisonKey(projectPath)) return null;
    registerGuiDevDefs(existing.defs);
    setDevGuiStatus('ready');
    return existing;
  }

  const generation = ++devSessionGeneration;

  // 1) 先同步 Rust 宿主登记态（主仓库根；失败则开发能力不可用）
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('dev_init_session', { baseRepo: projectPath });
    if (generation !== devSessionGeneration) return null;
    if (signal?.aborted) {
      await teardownGuiDevSession();
      return null;
    }
  } catch (e) {
    if (generation !== devSessionGeneration) return null;
    // 审计 P1：不静默吞异常——显式标记不可用，GUI 面板提示
    console.error('[H4] dev_init_session 失败：', e);
    setDevGuiStatus('unavailable');
    return null;
  }

  // 2) 宿主就绪后初始化 DevSession，并在注册 dev.* 前恢复 durable acceptance。
  try {
    const { createTauriJsonlFs } = await import('./tauri-run');
    const session = initDevSession({
      baseRepoPath: projectPath,
      env: 'tauri',
      evidenceRoot: evidenceRootFor(projectPath),
      acceptancePersistence: createHostAcceptanceStoreWithFs(
        `${projectPath.replace(/[/\\]+$/, '')}/.slimemold/acceptance`,
        `${projectPath.replace(/[/\\]+$/, '')}-workers`,
        'records',
        createTauriJsonlFs(),
      ),
    });
    if (generation !== devSessionGeneration) {
      if (getDevSession() === session) resetDevSession();
      return null;
    }
    await session.loadAcceptances();
    if (generation !== devSessionGeneration) {
      if (getDevSession() === session) resetDevSession();
      return null;
    }
    if (signal?.aborted) {
      await teardownGuiDevSession();
      return null;
    }
    registerGuiDevDefs(session.defs);
    setDevGuiStatus('ready');
    return session;
  } catch (e) {
    if (generation !== devSessionGeneration) return null;
    console.error('[H4] Acceptance store 初始化/加载失败：', e);
    await teardownGuiDevSession().catch(() => {});
    resetDevSession();
    setDevGuiStatus('unavailable');
    return null;
  }
}

/**
 * 卸载 GUI DevSession：先清空 Rust 宿主登记态（防旧项目泄漏），再移除 dev 节点定义 + 重置单例。
 * 返回 Promise（await dev_clear_session）。
 */
export async function teardownGuiDevSession(): Promise<void> {
  devSessionGeneration += 1;
  // 先清空宿主登记态（切换/关闭项目时旧 worktree 登记不得泄漏到新项目）
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('dev_clear_session');
    } catch (e) {
      // 清空失败不阻断 teardown（前端 session 已重置；Rust 侧 dev_exec 会 fail-closed）
      console.error('[H4] dev_clear_session 失败：', e);
    }
  }
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
  setDevGuiStatus('idle');
}
