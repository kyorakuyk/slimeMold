import { isTauri } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { loadPluginFromSource } from './loader';

export const PLUGIN_DIR = 'plugins';

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
    if (!entry.isDirectory) continue;
    const base = `${PLUGIN_DIR}/${entry.name}`;
    try {
      const manifestText = await fs.readTextFile(`${base}/manifest.json`, opts);
      const manifest = JSON.parse(manifestText);
      const entryCode = await fs.readTextFile(
        `${base}/${manifest.entry ?? 'index.js'}`,
        opts,
      );
      const { plugin, defs } = await loadPluginFromSource(
        manifestText,
        entryCode,
        'dir',
        base,
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
  const parsed = JSON.parse(manifestText);
  if (parsed?.entry) entryName = String(parsed.entry);

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
