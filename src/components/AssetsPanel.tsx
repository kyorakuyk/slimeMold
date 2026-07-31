import { useState } from 'react';
import { Download, Trash2, FileCode2, FileText, Image as ImageIcon, FolderOpen } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { downloadBlob, isTauri } from '../platform/env';
import type { AssetMeta } from '../types';

function kindIcon(kind: string) {
  if (kind === 'image') return <ImageIcon size={14} />;
  if (kind === 'code') return <FileCode2 size={14} />;
  return <FileText size={14} />;
}

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'application/json';
  if (ext === 'md') return 'text/markdown';
  if (ext === 'py') return 'text/x-python';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return `image/${ext === 'svg' ? 'svg+xml' : ext}`;
  if (ext === 'html') return 'text/html';
  return 'text/plain';
}

export default function AssetsPanel({ embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const assets = useWorkflowStore((s) => s.workflows[s.activeWfId]?.assets);
  const removeAsset = useWorkflowStore((s) => s.removeAsset);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assetList = assets ?? [];
  const selected: AssetMeta | null = assetList.find((a) => a.id === selectedId) ?? assetList[0] ?? null;

  const handleDownload = (a: AssetMeta) => {
    downloadBlob(a.name, a.content, mimeOf(a.name));
  };

  const openInExplorer = async (a: AssetMeta) => {
    if (!a.path || !isTauri) return;
    try {
      const tauri = (window as any).__TAURI__;
      await tauri.dialog.openPath?.(a.path);
    } catch {
      /* 忽略 */
    }
  };

  const body = (
    <div className="flex min-h-0 flex-1">
      {/* 左：资产列表 */}
      <div className="w-[200px] shrink-0 overflow-y-auto border-r border-line bg-paper-soft">
        {!activeWfId ? (
          <p className="px-3 py-4 text-xs text-ink-faint">请先创建或打开工作流</p>
        ) : assetList.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">
            还没有资产。用「写文件」节点生成的文件会显示在这里。
          </p>
        ) : (
          assetList.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={`flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left transition-colors ${
                selectedId === a.id ? 'bg-accent-soft/30' : 'hover:bg-white'
              }`}
            >
              <span className="shrink-0 text-ink-faint">{kindIcon(a.kind)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink" title={a.name}>
                  {a.name}
                </span>
                <span className="block text-[10px] text-ink-faint">
                  {a.inWorkspace ? '工作区' : '工作流内'} · {new Date(a.createdAt).toLocaleTimeString()}
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      {/* 右：预览 + 操作 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <p className="px-4 py-4 text-xs text-ink-faint">选择左侧资产以预览</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-ink" title={selected.name}>
                  {selected.name}
                </div>
                {selected.path && (
                  <div className="truncate text-[10px] text-ink-faint" title={selected.path}>
                    {selected.path}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="sm-btn"
                  title="下载 / 导出"
                  onClick={() => handleDownload(selected)}
                >
                  <Download size={14} />
                </button>
                {selected.path && isTauri && (
                  <button
                    className="sm-btn"
                    title="在文件管理器中打开"
                    onClick={() => openInExplorer(selected)}
                  >
                    <FolderOpen size={14} />
                  </button>
                )}
                <button
                  className="sm-btn text-err hover:border-err"
                  title="删除资产记录"
                  onClick={() => removeAsset(selected.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto bg-paper-soft p-3">
              {selected.kind === 'image' ? (
                <img
                  src={
                    selected.content.startsWith('data:')
                      ? selected.content
                      : `data:image/png;base64,${selected.content}`
                  }
                  alt={selected.name}
                  className="max-w-full"
                />
              ) : (
                <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed text-ink-soft">
                  {selected.content}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}
