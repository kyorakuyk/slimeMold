import { useRef } from 'react';
import { X, RefreshCw, FileUp, Trash2, FolderOpen } from 'lucide-react';
import { useRegistryStore } from '../store/registryStore';
import {
  scanPluginsDir,
  scanProgramCustomNodes,
  scanProjectCustomNodes,
  importPluginFiles,
  removePlugin,
} from '../plugins/pluginManager';
import { isTauri } from '../platform/env';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import type { NodeDefinition } from '../types/node';

/** 步骤 13 阶段 D：提取「提权徽标」判定为纯函数，便于单测。能力高于 io 的节点视为已提权，面板标红。 */
export function getEscalatedDefs(defs: NodeDefinition[]): NodeDefinition[] {
  return defs.filter(
    (d) => d.minCapability && d.minCapability !== 'compute' && d.minCapability !== 'io',
  );
}

interface PluginPanelProps {
  onClose?: () => void;
  embedded?: boolean;
}

/** 扫描自定义节点：先扫程序级（全局），再扫当前项目级（仅本项目） */
async function scanAllCustomNodes(): Promise<void> {
  await scanProgramCustomNodes();
  await scanProjectCustomNodes();
}

/** 在资源管理器打开**程序安装目录**下的 custom_nodes/ 文件夹（<程序根>/custom_nodes，不存在则创建），方便用户投放节点包 */
async function openCustomNodesFolder(): Promise<void> {
  if (!isTauri) return;
  try {
    const { resourceDir } = await import('@tauri-apps/api/path');
    const programRoot = (await resourceDir()).replace(/\\/g, '/');
    const target = `${programRoot}/custom_nodes`;
    const fs = await import('@tauri-apps/plugin-fs');
    if (!(await fs.exists(target))) {
      await fs.mkdir(target, { recursive: true });
    }
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(target);
  } catch (e) {
    useWorkflowStore.getState().addLog('error', `打开 custom_nodes 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 插件管理弹层：扫描目录 / 文件导入 / 卸载 */
export default function PluginPanel({ onClose, embedded = false }: PluginPanelProps) {
  const t = useT('panels');
  const plugins = useRegistryStore((s) => s.plugins);
  const defs = useRegistryStore((s) => s.defs);
  const fileRef = useRef<HTMLInputElement>(null);
  const pluginSandbox = useViewStore((s) => s.pluginSandbox);
  const setPluginSandbox = useViewStore((s) => s.setPluginSandbox);

  const nodeCount = (pluginId: string) =>
    Object.values(defs).filter((d) => d.pluginId === pluginId).length;

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <button
          className="sm-btn"
          onClick={() => scanPluginsDir()}
          title={isTauri ? t('plugins.scanDirTitle') : t('plugins.scanDirTitleBrowser')}
          disabled={!isTauri}
        >
          <RefreshCw size={13} /> {t('plugins.scanDir')}
        </button>
        <button
          className="sm-btn"
          onClick={() => scanAllCustomNodes()}
          title={isTauri ? t('plugins.scanCustomTitle') : t('plugins.scanDirTitleBrowser')}
          disabled={!isTauri}
        >
          <RefreshCw size={13} /> {t('plugins.scanCustom')}
        </button>
        <button
          className="sm-btn"
          onClick={() => openCustomNodesFolder()}
          title={isTauri ? t('plugins.openCustomTitle') : t('plugins.scanDirTitleBrowser')}
          disabled={!isTauri}
        >
          <FolderOpen size={13} /> {t('plugins.openCustom')}
        </button>
        <button className="sm-btn" onClick={() => fileRef.current?.click()}>
          <FileUp size={13} /> {t('plugins.importFile')}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".json,.js"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) importPluginFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {/* H2 沙箱执行开关：影响此后扫描/导入的插件；Worker 线程隔离但不隔离网络 */}
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink"
          title={t('plugins.sandboxHint')}
        >
          <input
            type="checkbox"
            className="cursor-pointer"
            checked={pluginSandbox}
            onChange={(e) => setPluginSandbox(e.target.checked)}
          />
          {t('plugins.sandbox')}
        </label>
        <span className="ml-auto text-[11px] text-ink-faint">
          {isTauri ? t('plugins.dirHint') : t('plugins.dirHintBrowser')}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {plugins.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] text-ink-faint">{t('plugins.empty')}</p>
            <p className="max-w-80 text-[11px] leading-relaxed text-ink-faint">
              {t('plugins.emptyHint')}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {plugins.map((p) => {
              const pdefs = Object.values(defs).filter((d) => d.pluginId === p.manifest.id);
              const escalated = getEscalatedDefs(pdefs);
              return (
                <li
                  key={p.manifest.id}
                  className="rounded border border-line px-3 py-2.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-[13px] text-ink">
                        {p.manifest.name}
                        <span className="ml-2 text-[11px] text-ink-faint">
                          v{p.manifest.version ?? '0.0.0'} · {t('plugins.nodeCount', { count: nodeCount(p.manifest.id) })}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                        {p.manifest.description ?? p.path ?? p.manifest.id}
                        {p.source === 'custom' && (
                          <span className="ml-2 rounded bg-ink-faint/10 px-1.5 py-0.5 text-[10px] text-ink-faint">
                            {t('plugins.customBadge')}
                          </span>
                        )}
                        {p.source === 'dir' && (
                          <span className="ml-2 rounded bg-ink-faint/10 px-1.5 py-0.5 text-[10px] text-ink-faint">
                            {t('plugins.dirBadge')}
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
                      title={t('plugins.unloadTitle')}
                      onClick={() => removePlugin(p.manifest.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {/* 步骤 13 阶段 D：提权节点透明标识——能力等级高于 io 的节点打红色徽标 */}
                  {escalated.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {escalated.map((d) => (
                        <span
                          key={d.typeId}
                          title={t('plugins.escalatedTitle', { cap: d.minCapability })}
                          className="rounded bg-err/10 px-1.5 py-0.5 text-[10px] text-err"
                        >
                          {t('plugins.escalated', { cap: d.minCapability, name: d.name })}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  if (embedded) return inner;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="flex h-[420px] w-[560px] flex-col overflow-hidden rounded-lg border border-line bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">{t('plugins.title')}</h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {t('plugins.subtitle')}
            </p>
          </div>
          <button className="cursor-pointer text-ink-faint hover:text-ink" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        {inner}
      </div>
    </div>
  );
}
