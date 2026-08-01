import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Download,
  Trash2,
  FileCode2,
  FileText,
  Image as ImageIcon,
  FolderOpen,
  Upload,
} from 'lucide-react';
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

function inferKind(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'go', 'rs', 'cpp', 'c', 'sh'].includes(ext))
    return 'code';
  if (ext === 'json') return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return 'text';
}

type Tab = 'export' | 'import';

export default function AssetsPanel({
  embedded = false,
}: {
  onClose?: () => void;
  embedded?: boolean;
}) {
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const assets = useWorkflowStore((s) => s.workflows[s.activeWfId]?.assets);
  const removeAsset = useWorkflowStore((s) => s.removeAsset);
  const addAsset = useWorkflowStore((s) => s.addAsset);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('export');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [hashMap, setHashMap] = useState<Record<string, string>>({});

  const assetList = useMemo(() => assets ?? [], [assets]);

  // 异步预计算每项资产内容的 SHA-256（十六进制），用于按"文件哈希"检索
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const a of assetList) {
        // 图片资产 content 为巨大 base64，哈希计算慢且检索价值低，跳过
        if (!a.content || a.kind === 'image') {
          next[a.id] = '';
          continue;
        }
        try {
          const buf = new TextEncoder().encode(a.content);
          const digest = await crypto.subtle.digest('SHA-256', buf);
          next[a.id] = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        } catch {
          next[a.id] = '';
        }
      }
      if (!cancelled) setHashMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetList]);

  // 过滤：文件名模糊匹配 OR 内容 SHA-256 十六进制串包含搜索词
  const q = query.trim().toLowerCase();
  const visibleAssets = q
    ? assetList.filter(
        (a) =>
          a.name.toLowerCase().includes(q) || (hashMap[a.id] ?? '').includes(q),
      )
    : assetList;

  // 选中项优先取 selectedId 且在可见列表中，否则回退到可见列表首项
  const selected: AssetMeta | null =
    visibleAssets.find((a) => a.id === selectedId) ?? visibleAssets[0] ?? null;

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

  // 导入：把用户选择的本地文件读入资产库（工作流内部资产，随工作流管理）
  const handleImportFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !activeWfId) return;
    setImporting(true);
    try {
      for (const file of Array.from(fileList)) {
        const kind = inferKind(file.name);
        let content = '';
        if (kind === 'image') {
          const buf = await file.arrayBuffer();
          content = btoa(
            new Uint8Array(buf).reduce((acc, b) => acc + String.fromCharCode(b), ''),
          );
        } else {
          content = await file.text();
        }
        const meta: AssetMeta = {
          id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          path: null,
          kind,
          content,
          createdAt: new Date().toISOString(),
          inWorkspace: false,
        };
        addAsset(meta);
      }
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const exportView = (
    <div className="flex min-h-0 flex-1">
      {/* 左：资产列表 */}
      <div className="w-[200px] shrink-0 overflow-y-auto border-r border-line bg-paper-soft">
        {!activeWfId ? (
          <p className="px-3 py-4 text-xs text-ink-faint">请先创建或打开工作流</p>
        ) : assetList.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">
            还没有资产。用「写文件」节点生成的文件，或切到「导入」上传文件，会显示在这里。
          </p>
        ) : visibleAssets.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">
            没有匹配「{query}」的资产
          </p>
        ) : (
          visibleAssets.map((a) => (
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

  const importView = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleImportFiles(e.target.files)}
      />
      <button
        className="sm-btn self-start"
        disabled={!activeWfId || importing}
        onClick={() => fileRef.current?.click()}
      >
        <Upload size={14} />
        {importing ? '导入中…' : '选择文件上传到资产库'}
      </button>
      {!activeWfId ? (
        <p className="text-xs text-ink-faint">请先创建或打开工作流</p>
      ) : (
        <p className="text-xs text-ink-faint">
          支持任意文件。文本/代码类会按原内容入库；图片转为预览数据。导入的文件作为「工作流内」资产，
          可在「导出」页预览与下载，随工作流删除而销毁（不写入你的磁盘文件夹）。
        </p>
      )}
      {visibleAssets.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-ink-soft">
            已入库资产（共 {visibleAssets.length}）
          </p>
          {visibleAssets.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5"
            >
              <span className="shrink-0 text-ink-faint">{kindIcon(a.kind)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink" title={a.name}>
                {a.name}
              </span>
              <button
                className="sm-btn shrink-0"
                title="下载"
                onClick={() => handleDownload(a)}
              >
                <Download size={13} />
              </button>
              <button
                className="sm-btn shrink-0 text-err hover:border-err"
                title="删除"
                onClick={() => removeAsset(a.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tab 切换 */}
      <div className="flex shrink-0 border-b border-line">
        <button
          onClick={() => setTab('export')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'export' ? 'border-b-2 border-accent text-ink' : 'text-ink-faint hover:text-ink'
          }`}
        >
          导出
        </button>
        <button
          onClick={() => setTab('import')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'import' ? 'border-b-2 border-accent text-ink' : 'text-ink-faint hover:text-ink'
          }`}
        >
          导入
        </button>
      </div>
      {/* 搜索框：按文件名或内容 SHA-256 哈希检索 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件名或内容哈希…"
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        {query && (
          <button
            className="sm-btn shrink-0"
            title="清除搜索"
            onClick={() => setQuery('')}
          >
            清除
          </button>
        )}
      </div>
      {tab === 'export' ? exportView : importView}
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}
