import { isTauri } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { loadPluginFromSource } from './loader';
import { sandboxManager } from './sandbox';
import { assertPluginRelativePath } from './pluginPath';
import { SLIMEMOLD_DIR } from '../io/projectIO';
import type { NodeDefinition } from '../types/node';

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
    log('info', '浏览器模式不支持目录扫描，请使用「从文件导入插件」');
    return 0;
  }
  const fs = await import('@tauri-apps/plugin-fs');
  const { BaseDirectory } = fs;
  const opts = { baseDir: BaseDirectory.AppData };

  const dirExists = await fs.exists(PLUGIN_DIR, opts);
  if (!dirExists) {
    await fs.mkdir(PLUGIN_DIR, { ...opts, recursive: true });
    log('info', '已创建插件目录（AppData/plugins），放入插件后可重新扫描');
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
      log('info', `插件已加载：${plugin.manifest.name}（${defs.length} 个节点）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `插件 ${entry.name} 加载失败：${message}`);
    }
  }
  return loaded;
}

/** 浏览器/通用模式：从用户选择的文件（manifest.json + 入口 js）导入插件 */
export async function importPluginFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  const manifestFile = list.find((f) => f.name === 'manifest.json');
  if (!manifestFile) {
    log('error', '导入失败：未找到 manifest.json');
    return;
  }
  const manifestText = await manifestFile.text();
  let entryName = 'index.js';
  try {
    const parsed = JSON.parse(manifestText);
    entryName = assertPluginRelativePath(parsed?.entry ?? 'index.js');
  } catch (err) {
    log('error', `导入失败：manifest.entry 无效（${err instanceof Error ? err.message : String(err)}）`);
    return;
  }

  const entryFile = list.find((f) => f.name === entryName);
  if (!entryFile) {
    log('error', `导入失败：未找到入口文件 ${entryName}`);
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
    log('info', `插件已导入：${plugin.manifest.name}（${defs.length} 个节点）`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `插件导入失败：${message}`);
  }
}

export function removePlugin(pluginId: string): void {
  useRegistryStore.getState().unregisterPlugin(pluginId);
  log('info', `插件已卸载：${pluginId}`);
}

/** Stop all in-flight plugin workers before a project context is replaced. */
export function terminatePluginRuntime(): void {
  sandboxManager.terminateAll();
}

/**
 * 扫描一个 `custom_nodes/` 目录并加载其中的节点包。
 * @param base 节点包根目录（绝对路径）
 * @param scope 'program' = 程序安装目录（全局生效）；'project' = 当前项目目录（仅本项目）
 */
async function scanCustomNodesDir(
  base: string,
  scope: 'program' | 'project',
  canRegister: () => boolean = () => true,
): Promise<number> {
  if (!isTauri) {
    log('info', '浏览器模式不支持自定义节点扫描（需桌面端）');
    return 0;
  }
  const fs = await import('@tauri-apps/plugin-fs');
  if (!canRegister()) return 0;
  let dirExists = false;
  try {
    dirExists = await fs.exists(base);
  } catch (e) {
    // 权限范围外（如项目目录不在 capabilities 白名单）时静默降级，不抛 UnhandledRejection
    log('info', `自定义节点目录不可访问（跳过扫描）：${base} —— ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  if (!dirExists) {
    if (!canRegister()) return 0;
    try {
      await fs.mkdir(base, { recursive: true });
      if (!canRegister()) return 0;
      log('info', `已创建自定义节点目录（${base}），放入节点包后可重新扫描`);
    } catch (e) {
      log('info', `自定义节点目录无法创建（跳过）：${base} —— ${e instanceof Error ? e.message : String(e)}`);
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
      log('info', `自定义节点已加载：${plugin.manifest.name}（${defs.length} 个节点，能力由 extends 声明决定，范围=${scope === 'program' ? '全局' : '本项目'}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `自定义节点 ${entry.name} 加载失败：${message}`);
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
    log('info', `程序级自定义节点扫描跳过：${e instanceof Error ? e.message : String(e)}`);
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
    log('info', `项目级自定义节点扫描跳过（目录可能不在文件系统权限范围内）：${e instanceof Error ? e.message : String(e)}`);
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
  log('info', `已卸载 ${projectPluginIds.length} 个项目级自定义节点`);
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
