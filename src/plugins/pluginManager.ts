import { isTauri } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { loadPluginFromSource } from './loader';
import { sandboxManager } from './sandbox';
import { assertPluginRelativePath } from './pluginPath';
import { SLIMEMOLD_DIR } from '../io/projectIO';
import type { NodeDefinition } from '../types/node';
// 日志文案跟随界面语言：通过 i18n 默认导出的 t 调用（本模块不是 React 组件，不能用 useT）。
import i18n from '../i18n';

/** 当前是否启用插件沙箱执行（H2）：由 viewStore.pluginSandbox 决定 */
function sandboxEnabled(): boolean {
  return useViewStore.getState().pluginSandbox;
}

export const PLUGIN_DIR = 'plugins';
/** 自定义节点目录名（位于程序安装目录下：<程序根>/custom_nodes） */
export const CUSTOM_NODES_DIR = 'custom_nodes';

export interface ProjectPluginScanContext {
  projectId?: string | null;
  projectPath: string | null;
  signal?: AbortSignal;
}

function log(level: 'info' | 'error', message: string): void {
  useWorkflowStore.getState().addLog(level, message);
}

/** Tauri 模式：扫描 AppData/plugins 下的插件目录（每个子目录一个插件） */
export async function scanPluginsDir(): Promise<number> {
  if (!isTauri) {
    log('info', i18n.t('plugin.log.browserNoDirScan'));
    return 0;
  }
  const fs = await import('@tauri-apps/plugin-fs');
  const { BaseDirectory } = fs;
  const opts = { baseDir: BaseDirectory.AppData };

  const dirExists = await fs.exists(PLUGIN_DIR, opts);
  if (!dirExists) {
    await fs.mkdir(PLUGIN_DIR, { ...opts, recursive: true });
    log('info', i18n.t('plugin.log.dirCreated'));
    return 0;
  }

  const entries = await fs.readDir(PLUGIN_DIR, opts);
  let loaded = 0;
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    const base = `${PLUGIN_DIR}/${entry.name}`;
    try {
      const manifestText = await fs.readTextFile(`${base}/manifest.json`, opts);
      const manifest = JSON.parse(manifestText);
      const entryName = assertPluginRelativePath(manifest.entry ?? 'index.js');
      const entryCode = await fs.readTextFile(`${base}/${entryName}`, opts);
      const { plugin, defs } = await loadPluginFromSource(
        manifestText,
        entryCode,
        'dir',
        base,
        { sandbox: sandboxEnabled() },
      );
      useRegistryStore.getState().registerPlugin(plugin, defs);
      loaded += 1;
      log('info', i18n.t('plugin.log.loaded', { name: plugin.manifest.name, count: defs.length }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', i18n.t('plugin.log.loadFailed', { name: entry.name, message }));
    }
  }
  return loaded;
}

/** 浏览器/通用模式：从用户选择的文件（manifest.json + 入口 js）导入插件 */
export async function importPluginFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  const manifestFile = list.find((f) => f.name === 'manifest.json');
  if (!manifestFile) {
    log('error', i18n.t('plugin.log.importNoManifest'));
    return;
  }
  const manifestText = await manifestFile.text();
  let entryName = 'index.js';
  try {
    const parsed = JSON.parse(manifestText);
    entryName = assertPluginRelativePath(parsed?.entry ?? 'index.js');
  } catch (err) {
    log('error', i18n.t('plugin.log.importEntryInvalid', {
      message: err instanceof Error ? err.message : String(err),
    }));
    return;
  }

  const entryFile = list.find((f) => f.name === entryName);
  if (!entryFile) {
    log('error', i18n.t('plugin.log.importEntryMissing', { name: entryName }));
    return;
  }
  try {
    const entryCode = await entryFile.text();
    const { plugin, defs } = await loadPluginFromSource(
      manifestText,
      entryCode,
      'files',
      undefined,
      { sandbox: sandboxEnabled() },
    );
    useRegistryStore.getState().registerPlugin(plugin, defs);
    log('info', i18n.t('plugin.log.imported', { name: plugin.manifest.name, count: defs.length }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', i18n.t('plugin.log.importFailed', { message }));
  }
}

export function removePlugin(pluginId: string): void {
  useRegistryStore.getState().unregisterPlugin(pluginId);
  log('info', i18n.t('plugin.log.unloaded', { name: pluginId }));
}

/** Stop all in-flight plugin workers before a project context is replaced. */
export function terminatePluginRuntime(): void {
  sandboxManager.terminateAll();
}

/** 按 program/project scope 扫描 `custom_nodes/` 并注册成功加载的节点包。
 * 插件加载后的 `canRegister` 检查会阻止过期注册；这仍是可信 JS/TS 扩展，不是进程级沙箱（ADR-SM-074）。
 */
async function scanCustomNodesDir(
  base: string,
  scope: 'program' | 'project',
  canRegister: () => boolean = () => true,
): Promise<number> {
  if (!isTauri) {
    log('info', i18n.t('plugin.log.customNodesBrowserUnsupported'));
    return 0;
  }
  const fs = await import('@tauri-apps/plugin-fs');
  if (!canRegister()) return 0;
  let dirExists = false;
  try {
    dirExists = await fs.exists(base);
  } catch (e) {
    // 权限范围外（如项目目录不在 capabilities 白名单）时静默降级，不抛 UnhandledRejection
    log('info', i18n.t('plugin.log.customNodesDirUnreadable', {
      path: base,
      message: e instanceof Error ? e.message : String(e),
    }));
    return 0;
  }
  if (!dirExists) {
    if (!canRegister()) return 0;
    try {
      await fs.mkdir(base, { recursive: true });
      if (!canRegister()) return 0;
      log('info', i18n.t('plugin.log.customNodesDirCreated', { path: base }));
    } catch (e) {
      log('info', i18n.t('plugin.log.customNodesDirCreateFailed', {
        path: base,
        message: e instanceof Error ? e.message : String(e),
      }));
    }
    return 0;
  }
  if (!canRegister()) return 0;
  const entries = await readDirSafe(base, fs);
  let loaded = 0;
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    if (!canRegister()) return loaded;
    const packDir = `${base}/${entry.name}`;
    try {
      const manifestText = await fs.readTextFile(`${packDir}/manifest.json`);
      const manifest = JSON.parse(manifestText);
      const entryName = assertPluginRelativePath(manifest.entry ?? 'index.js');
      const entryCode = await fs.readTextFile(`${packDir}/${entryName}`);
      if (!canRegister()) return loaded;
      const { plugin, defs } = await loadPluginFromSource(
        manifestText,
        entryCode,
        'custom',
        packDir,
        { sandbox: sandboxEnabled() },
      );
      if (!canRegister()) return loaded;
      // 标注生效范围：程序级全局、项目级仅本项目
      useRegistryStore.getState().registerPlugin({ ...plugin, source: 'custom', scope }, defs);
      loaded += 1;
      log('info', i18n.t('plugin.log.customNodesLoaded', {
        name: plugin.manifest.name,
        count: defs.length,
        scope: i18n.t(scope === 'program' ? 'plugin.log.scopeProgram' : 'plugin.log.scopeProject'),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', i18n.t('plugin.log.customNodesLoadFailed', { name: entry.name, message }));
    }
  }
  return loaded;
}

/** 程序安装目录下的 custom_nodes（全局生效，跨项目可用） */
export async function scanProgramCustomNodes(): Promise<number> {
  try {
    const { resourceDir } = await import('@tauri-apps/api/path');
    const programRoot = (await resourceDir()).replace(/\\/g, '/');
    return await scanCustomNodesDir(`${programRoot}/${CUSTOM_NODES_DIR}`, 'program');
  } catch (e) {
    // 兜底：任何未预期错误（含 fs scope 之外）静默降级为「扫描 0 个」，避免 UnhandledRejection
    log('info', i18n.t('plugin.log.programScanSkipped', {
      message: e instanceof Error ? e.message : String(e),
    }));
    return 0;
  }
}

/** 当前项目目录下的 custom_nodes（仅本项目内生效；无打开项目则返回 0） */
export async function scanProjectCustomNodes(
  context?: ProjectPluginScanContext,
): Promise<number> {
  try {
    const current = useWorkflowStore.getState();
    const projectPath = context?.projectPath ?? current.projectPath;
    const expectedProjectId =
      context?.projectId !== undefined ? context.projectId : current.projectId;
    if (!projectPath) return 0;
    const signal = context?.signal;
    const canRegister = (): boolean => {
      const state = useWorkflowStore.getState();
      return (
        !signal?.aborted
        && state.projectPath === projectPath
        && (expectedProjectId == null || state.projectId === expectedProjectId)
      );
    };
    if (!canRegister()) return 0;
    // 自愈：确保项目根目录已注入 fs:scope 操作权限（openProjectByPath 已授权，此处兜底防竞态）
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (!canRegister()) return 0;
        await invoke('grant_project_access', { path: projectPath.replace(/\\/g, '/') }).catch(() => {});
        if (!canRegister()) return 0;
      } catch {
        /* 授权失败不阻断扫描（可能已在 scope 内） */
      }
    }
    if (!canRegister()) return 0;
    const root = projectPath.replace(/\\/g, '/');
    // 2026-08-10：项目级 custom_nodes 迁移到 .slimemold/custom_nodes（与项目配置集中管理）。
    // 兼容旧路径 <项目根>/custom_nodes：仍会扫描，避免已有节点的项目升级后丢节点。
    const newDir = `${root}/${SLIMEMOLD_DIR}/${CUSTOM_NODES_DIR}`;
    const legacyDir = `${root}/${CUSTOM_NODES_DIR}`;
    const n = await scanCustomNodesDir(newDir, 'project', canRegister);
    const m = await scanCustomNodesDir(legacyDir, 'project', canRegister);
    return n + m;
  } catch (e) {
    // 兜底：项目目录若不在 capabilities fs scope 内（如位于非 $HOME/$DOCUMENT 盘符），静默跳过
    log('info', i18n.t('plugin.log.projectScanSkipped', {
      message: e instanceof Error ? e.message : String(e),
    }));
    return 0;
  }
}

/** 卸载所有「项目级」自定义节点（切换/关闭项目时调用，避免污染下一个项目） */
export function unloadProjectCustomNodes(): void {
  const { plugins, defs } = useRegistryStore.getState();
  const projectPluginIds = plugins
    .filter((p) => p.source === 'custom' && p.scope === 'project')
    .map((p) => p.manifest.id);
  if (projectPluginIds.length === 0) return;
  const kept: Record<string, NodeDefinition> = {};
  for (const [k, v] of Object.entries(defs)) {
    if (!v.pluginId || !projectPluginIds.includes(v.pluginId)) kept[k] = v;
  }
  useRegistryStore.setState({
    defs: kept,
    plugins: plugins.filter((p) => !projectPluginIds.includes(p.manifest.id)),
  });
  log('info', i18n.t('plugin.log.projectNodesUnloaded', { count: projectPluginIds.length }));
}

/** 安全读取目录：某些 Tauri 版本 readDir 在无子项时抛错，做兜底 */
async function readDirSafe(
  dir: string,
  fs: typeof import('@tauri-apps/plugin-fs'),
): Promise<Array<{ name: string; isDirectory: boolean; isSymlink: boolean }>> {
  try {
    return (await fs.readDir(dir)) as Array<{
      name: string;
      isDirectory: boolean;
      isSymlink: boolean;
    }>;
  } catch {
    return [];
  }
}
