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
import type { NodeDefinition } from '../types';

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
  const plugins = useRegistryStore((s) => s.plugins);
  const defs = useRegistryStore((s) => s.defs);
  const fileRef = useRef<HTMLInputElement>(null);

  const nodeCount = (pluginId: string) =>
    Object.values(defs).filter((d) => d.pluginId === pluginId).length;

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <button
          className="sm-btn"
          onClick={() => scanPluginsDir()}
          title={isTauri ? '扫描 AppData/plugins 目录' : '仅桌面端可用'}
          disabled={!isTauri}
        >
          <RefreshCw size={13} /> 扫描插件目录
        </button>
        <button
          className="sm-btn"
          onClick={() => scanAllCustomNodes()}
          title={isTauri ? '扫描程序级（全局）+ 项目级 custom_nodes/' : '仅桌面端可用'}
          disabled={!isTauri}
        >
          <RefreshCw size={13} /> 扫描自定义节点
        </button>
        <button
          className="sm-btn"
          onClick={() => openCustomNodesFolder()}
          title={isTauri ? '在资源管理器打开程序安装目录下的 custom_nodes/' : '仅桌面端可用'}
          disabled={!isTauri}
        >
          <FolderOpen size={13} /> 打开 custom_nodes
        </button>
        <button className="sm-btn" onClick={() => fileRef.current?.click()}>
          <FileUp size={13} /> 从文件导入
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
        <span className="ml-auto text-[11px] text-ink-faint">
          {isTauri ? '插件目录：AppData/plugins · 自定义节点：程序目录/custom_nodes（全局）+ 项目/custom_nodes（仅本项目）' : '浏览器模式：选择 manifest.json + index.js'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {plugins.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] text-ink-faint">尚未加载任何插件</p>
            <p className="max-w-80 text-[11px] leading-relaxed text-ink-faint">
              插件包 = 一个文件夹，内含 manifest.json（节点声明）与 index.js（ESM，导出
              executors）。参考项目内 plugin-examples/ 示例。
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
                          v{p.manifest.version ?? '0.0.0'} · {nodeCount(p.manifest.id)} 个节点
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                        {p.manifest.description ?? p.path ?? p.manifest.id}
                        {p.source === 'custom' && (
                          <span className="ml-2 rounded bg-ink-faint/10 px-1.5 py-0.5 text-[10px] text-ink-faint">
                            自定义·继承式提权
                          </span>
                        )}
                        {p.source === 'dir' && (
                          <span className="ml-2 rounded bg-ink-faint/10 px-1.5 py-0.5 text-[10px] text-ink-faint">
                            插件
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
                      title="卸载插件"
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
                          title={`该节点通过继承职业类提权至 ${d.minCapability} 级`}
                          className="rounded bg-err/10 px-1.5 py-0.5 text-[10px] text-err"
                        >
                          已提权·{d.minCapability} · {d.name}
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
            <h2 className="text-[13px] font-semibold text-ink">插件管理</h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              以 JS/TS 插件包扩展自定义工具节点
            </p>
          </div>
          <button className="cursor-pointer text-ink-faint hover:text-ink" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {inner}
      </div>
    </div>
  );
}
