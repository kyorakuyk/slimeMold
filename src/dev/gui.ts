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
let devGuiError: string | null = null;
let devSessionGeneration = 0;
let activeHostGeneration: number | null = null;
let ensureInFlight: Promise<ReturnType<typeof getDevSession>> | null = null;
let ensureInFlightProjectKey: string | null = null;

async function clearStaleHostSession(generation: number): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('dev_clear_session', { generation });
    if (activeHostGeneration === generation) activeHostGeneration = null;
  } catch (e) {
    // A newer Rust generation legitimately rejects the stale clear; preserve it.
    console.error('[H4] stale dev_clear_session 失败：', e);
  }
}
export function getDevGuiStatus(): DevGuiStatus {
  return devGuiStatus;
}
export function getDevGuiError(): string | null {
  return devGuiError;
}
export function setDevGuiStatus(s: DevGuiStatus): void {
  devGuiStatus = s;
  if (s !== 'unavailable') devGuiError = null;
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
async function initializeGuiDevSession(projectPath: string, signal?: AbortSignal): Promise<ReturnType<typeof getDevSession>> {
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
  let hostGeneration: number | null = null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const returnedGeneration = await invoke<number>('dev_init_session', { baseRepo: projectPath });
    if (!Number.isSafeInteger(returnedGeneration) || returnedGeneration <= 0) {
      throw new Error('dev_init_session returned an invalid generation');
    }
    if (generation !== devSessionGeneration) {
      await clearStaleHostSession(returnedGeneration);
      return null;
    }
    hostGeneration = returnedGeneration;
    activeHostGeneration = returnedGeneration;
    if (signal?.aborted) {
      await teardownGuiDevSession();
      return null;
    }
  } catch (e) {
    if (generation !== devSessionGeneration) return null;
    // 审计 P1：不静默吞异常——显式标记不可用，GUI 面板提示
    console.error('[H4] dev_init_session 失败：', e);
    devGuiError = e instanceof Error ? e.message : String(e);
    setDevGuiStatus('unavailable');
    return null;
  }

  // 2) 宿主就绪后初始化 DevSession，并在注册 dev.* 前恢复 durable acceptance。
  try {
    const { createTauriJsonlFs } = await import('./tauri-run');
    const session = initDevSession({
      baseRepoPath: projectPath,
      env: 'tauri',
      hostGeneration: hostGeneration!,
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
      await clearStaleHostSession(hostGeneration!);
      return null;
    }
    await session.loadAcceptances();
    if (generation !== devSessionGeneration) {
      if (getDevSession() === session) resetDevSession();
      await clearStaleHostSession(hostGeneration!);
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
    devGuiError = e instanceof Error ? e.message : String(e);
    await teardownGuiDevSession().catch(() => {});
    resetDevSession();
    setDevGuiStatus('unavailable');
    return null;
  }
}

export function ensureGuiDevSession(
  projectPath: string | null,
  signal?: AbortSignal,
): Promise<ReturnType<typeof getDevSession>> {
  if (!projectPath || signal?.aborted) return Promise.resolve(null);
  const projectKey = pathComparisonKey(projectPath);
  if (ensureInFlight && ensureInFlightProjectKey === projectKey) return ensureInFlight;
  if (ensureInFlight) {
    // A project transition fences the older initializer; its host generation
    // will be cleared when the older initializer observes the drift.
    devSessionGeneration += 1;
    ensureInFlight = null;
    ensureInFlightProjectKey = null;
  }
  const promise = initializeGuiDevSession(projectPath, signal);
  const wrapped = promise.finally(() => {
    if (ensureInFlight === wrapped) {
      ensureInFlight = null;
      ensureInFlightProjectKey = null;
    }
  });
  ensureInFlight = wrapped;
  ensureInFlightProjectKey = projectKey;
  return wrapped;
}

/**
 * 卸载 GUI DevSession：先清空 Rust 宿主登记态（防旧项目登记泄漏到新项目），再移除 dev 节点定义 + 重置单例。
 * 返回 Promise（await dev_clear_session）。
 */
export async function teardownGuiDevSession(): Promise<void> {
  ensureInFlight = null;
  ensureInFlightProjectKey = null;
  const lifecycleGeneration = ++devSessionGeneration;
  const hostGeneration = activeHostGeneration;
  // 先清空宿主登记态（切换/关闭项目时旧 worktree 登记不得泄漏到新项目）
  if (hostGeneration !== null) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('dev_clear_session', { generation: hostGeneration });
      if (activeHostGeneration === hostGeneration) activeHostGeneration = null;
    } catch (e) {
      // 清空失败不阻断 teardown；若 lifecycle 已过期，不得覆盖新 session。
      console.error('[H4] dev_clear_session 失败：', e);
    }
  }
  if (lifecycleGeneration !== devSessionGeneration) return;

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
