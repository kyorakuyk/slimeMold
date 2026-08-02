import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Download,
  Trash2,
  FileCode2,
  FileText,
  Image as ImageIcon,
  FolderOpen,
  Upload,
  ListChecks,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { downloadBlob, isTauri } from '../platform/env';
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener';
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

function formatBytes(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

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
  const addLog = useWorkflowStore((s) => s.addLog);
  const inspectAssetId = useViewStore((s) => s.inspectAssetId);
  const setInspectAsset = useViewStore((s) => s.setInspectAsset);
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);

  const [tab, setTab] = useState<'files' | 'import' | 'export'>('files');
  const [multiMode, setMultiMode] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [hashMap, setHashMap] = useState<Record<string, string>>({});

  const assetList = useMemo(() => assets ?? [], [assets]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const a of assetList) {
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

  const q = query.trim().toLowerCase();
  const visibleAssets = q
    ? assetList.filter(
        (a) => a.name.toLowerCase().includes(q) || (hashMap[a.id] ?? '').includes(q),
      )
    : assetList;

  const allSelected = visibleAssets.length > 0 && selectedIds.size === visibleAssets.length;

  const toggleMulti = () => {
    if (!multiMode) {
      // 第一次单击：进入多选模式
      setMultiMode(true);
      setSelectAll(false);
      setSelectedIds(new Set());
    } else if (!selectAll) {
      // 第二次单击：全选
      setSelectAll(true);
      setSelectedIds(new Set(visibleAssets.map((a) => a.id)));
    } else {
      // 第三次单击：取消全选（仍停留在多选模式）
      setSelectAll(false);
      setSelectedIds(new Set());
    }
  };

  // 退出多选模式：清空选择与全选状态
  const exitMulti = () => {
    setMultiMode(false);
    setSelectAll(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectAll(next.size === visibleAssets.length);
  };

  const openInExplorer = async (a: AssetMeta) => {
    if (!a.path || !isTauri) return;
    const winPath = a.path.replace(/\//g, '\\');
    const dir = winPath.includes('\\') ? winPath.slice(0, winPath.lastIndexOf('\\')) : winPath;
    try {
      await revealItemInDir(winPath);
    } catch (err1) {
      console.error('revealItemInDir 失败', err1);
      try {
        await openPath(dir);
      } catch (err2) {
        console.error('openPath 失败', err2);
        window.alert(`无法打开文件夹：\n${winPath}\n\n请手动复制路径到文件资源管理器打开。`);
      }
    }
  };

  const clickFile = (a: AssetMeta) => {
    setInspectAsset(a.id);
    if (!inspectorOpen) toggleInspector();
  };

  const handleBulkRemove = () => {
    if (selectedIds.size === 0) return;
    const list = visibleAssets.filter((a) => selectedIds.has(a.id));
    const names = list.map((a) => a.name).join('、');
    if (!window.confirm(`确定删除选中的 ${selectedIds.size} 个资产？\n${names}`)) return;
    list.forEach((a) => removeAsset(a.id));
    setSelectedIds(new Set());
    setSelectAll(false);
    if (inspectAssetId && selectedIds.has(inspectAssetId)) setInspectAsset(null);
    addLog('info', `已批量删除 ${list.length} 个资产`);
  };

  const handleImportFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !activeWfId) return;
    setImporting(true);
    const importedIds: string[] = [];
    try {
      for (const file of Array.from(fileList)) {
        const kind = inferKind(file.name);
        let content = '';
        if (kind === 'image') {
          const buf = await file.arrayBuffer();
          content = btoa(new Uint8Array(buf).reduce((acc, b) => acc + String.fromCharCode(b), ''));
        } else {
          content = await file.text();
        }
        const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        importedIds.push(id);
        const meta: AssetMeta = {
          id,
          name: file.name,
          path: null,
          kind,
          content,
          createdAt: new Date().toISOString(),
          inWorkspace: false,
        };
        addAsset(meta);
      }
      setTab('files');
      setSelectedIds(new Set(importedIds));
      addLog('info', `已导入 ${importedIds.length} 个资产`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 导出选中项（或多选模式全选）为 zip；未多选时导出当前 inspect 项
  const handleExport = () => {
    const ids = multiMode ? selectedIds : inspectAssetId ? new Set([inspectAssetId]) : new Set();
    const list = visibleAssets.filter((a) => ids.has(a.id));
    if (list.length === 0) {
      window.alert('没有可导出的资产。请在多选模式下选择文件，或先点击查看某个资产。');
      return;
    }
    list.forEach((a) => downloadBlob(a.name, a.content, mimeOf(a.name)));
    addLog('info', `已导出 ${list.length} 个资产`);
  };

  const checkbox = (checked: boolean, onChange: () => void, stop = true) => (
    <button
      type="button"
      onClick={(e) => {
        if (stop) e.stopPropagation();
        onChange();
      }}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-accent transition-colors hover:border-accent"
      style={{ background: checked ? 'var(--sm-accent)' : 'transparent' }}
      title={checked ? '取消选择' : '选择'}
    >
      {checked && <CheckSquare size={12} className="text-white" />}
    </button>
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部：导入 / 导出 / 文件列表 切换 */}
      <div className="flex shrink-0 border-b border-line">
        {([
          ['files', '文件列表'],
          ['import', '导入'],
          ['export', '导出'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              if (k === 'import') fileRef.current?.click();
              if (k === 'export') handleExport();
            }}
            className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
              tab === k
                ? 'border-b-2 border-accent text-ink'
                : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 第二行：多选键（左）+ 搜索栏（右） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          onClick={toggleMulti}
          className={`sm-btn shrink-0 ${multiMode ? 'border-accent text-accent' : ''}`}
          title={
            !multiMode
              ? '进入多选模式'
              : !selectAll
                ? '再次点击：全选'
                : '再次点击：取消全选'
          }
        >
          {!multiMode ? <ListChecks size={13} /> : selectAll ? <CheckSquare size={13} /> : <Square size={13} />}
          {multiMode ? (selectAll ? '全选' : '多选') : '多选'}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件名或内容哈希…"
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        {query && (
          <button className="sm-btn shrink-0" onClick={() => setQuery('')}>
            清除
          </button>
        )}
      </div>

      {/* 文件列表（仅 files tab，多选模式才显示左侧复选框） */}
      {/* 进入多选模式后，单击列表空白处（非文件项）退出多选模式 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onClick={(e) => {
          if (multiMode && e.target === e.currentTarget) exitMulti();
        }}
      >
        {!activeWfId ? (
          <p className="px-3 py-4 text-xs text-ink-faint">请先创建或打开工作流</p>
        ) : assetList.length === 0 ? (
          <div className="px-3 py-4 text-xs text-ink-faint">
            <p>还没有资产。</p>
            <p className="mt-1">点击上方「导入」上传文件，或用「写文件」节点生成文件。</p>
          </div>
        ) : visibleAssets.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">没有匹配「{query}」的资产</p>
        ) : (
          visibleAssets.map((a) => (
            <div
              key={a.id}
              onClick={() => clickFile(a)}
              className={`group flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 transition-colors ${
                inspectAssetId === a.id ? 'bg-accent-soft/30' : 'hover:bg-white'
              }`}
            >
              {multiMode && checkbox(selectedIds.has(a.id), () => toggleSelect(a.id))}
              <span className="shrink-0 text-ink-faint">{kindIcon(a.kind)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink" title={a.name}>
                  {a.name}
                </span>
                <span className="block text-[10px] text-ink-faint">
                  {a.inWorkspace ? '工作区' : '工作流内'} · {formatBytes(a.content)}
                </span>
              </span>
              {a.path && isTauri && (
                <button
                  className="sm-btn shrink-0 border-transparent px-1 text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
                  title="在文件管理器中打开"
                  onClick={(e) => {
                    e.stopPropagation();
                    openInExplorer(a);
                  }}
                >
                  <FolderOpen size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* 底部：导出 + 删除 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <button
          className="sm-btn flex-1 justify-center"
          disabled={!multiMode && !inspectAssetId}
          onClick={handleExport}
        >
          <Download size={13} />
          导出{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
        </button>
        <button
          className={`sm-btn flex-1 justify-center ${multiMode && selectedIds.size > 0 ? 'text-err hover:border-err' : ''}`}
          disabled={!multiMode || selectedIds.size === 0}
          onClick={handleBulkRemove}
        >
          <Trash2 size={13} />
          删除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleImportFiles(e.target.files)}
      />
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}
