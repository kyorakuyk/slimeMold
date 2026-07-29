import { useRef } from 'react';
import { X, RefreshCw, FileUp, Trash2 } from 'lucide-react';
import { useRegistryStore } from '../store/registryStore';
import {
  scanPluginsDir,
  importPluginFiles,
  removePlugin,
} from '../plugins/pluginManager';
import { isTauri } from '../platform/env';

interface PluginPanelProps {
  onClose: () => void;
}

/** 插件管理弹层：扫描目录 / 文件导入 / 卸载 */
export default function PluginPanel({ onClose }: PluginPanelProps) {
  const plugins = useRegistryStore((s) => s.plugins);
  const defs = useRegistryStore((s) => s.defs);
  const fileRef = useRef<HTMLInputElement>(null);

  const nodeCount = (pluginId: string) =>
    Object.values(defs).filter((d) => d.pluginId === pluginId).length;

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

        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <button
            className="sm-btn"
            onClick={() => scanPluginsDir()}
            title={isTauri ? '扫描 AppData/plugins 目录' : '仅桌面端可用'}
            disabled={!isTauri}
          >
            <RefreshCw size={13} /> 扫描插件目录
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
            {isTauri ? '插件目录：AppData/plugins' : '浏览器模式：选择 manifest.json + index.js'}
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
              {plugins.map((p) => (
                <li
                  key={p.manifest.id}
                  className="flex items-center justify-between rounded border border-line px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink">
                      {p.manifest.name}
                      <span className="ml-2 text-[11px] text-ink-faint">
                        v{p.manifest.version ?? '0.0.0'} · {nodeCount(p.manifest.id)} 个节点
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                      {p.manifest.description ?? p.path ?? p.manifest.id}
                    </p>
                  </div>
                  <button
                    className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
                    title="卸载插件"
                    onClick={() => removePlugin(p.manifest.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
