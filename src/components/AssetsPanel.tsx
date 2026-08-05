import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Download,
  Trash2,
  FileCode2,
  FileText,
  Image as ImageIcon,
  FolderOpen,
  ListChecks,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { downloadBlob, isTauri } from '../platform/env';
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener';
import { useT } from '../i18n/useT';
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
  const t = useT('panels');
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const assets = useWorkflowStore((s) => s.workflows[s.activeWfId]?.assets);
  const projectAssets = useWorkflowStore((s) => s.projectAssets);
  const removeAsset = useWorkflowStore((s) => s.removeAsset);
  const removeProjectAsset = useWorkflowStore((s) => s.removeProjectAsset);
  const addAsset = useWorkflowStore((s) => s.addAsset);
  const addProjectAsset = useWorkflowStore((s) => s.addProjectAsset);
  const addLog = useWorkflowStore((s) => s.addLog);
  const inspectAssetId = useViewStore((s) => s.inspectAssetId);
  const setInspectAsset = useViewStore((s) => s.setInspectAsset);
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);

  const [tab, setTab] = useState<'files' | 'import' | 'export'>('files');
  const [scope, setScope] = useState<'workflow' | 'project'>('workflow');
  const [multiMode, setMultiMode] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [hashMap, setHashMap] = useState<Record<string, string>>({});

  // 资产列表随当前作用域（工作流 / 项目）切换
  const assetList = useMemo(
    () => (scope === 'project' ? (projectAssets ?? []) : (assets ?? [])),
    [scope, assets, projectAssets],
  );

  const doRemove = (id: string) => {
    if (scope === 'project') {
      const refs = removeProjectAsset(id);
      if (refs.length > 0) {
        window.alert(
          t('assets.deleteRefs', { refs: refs.join('、') }),
        );
      }
    } else {
      removeAsset(id);
    }
  };
  const doAdd = (meta: AssetMeta) => {
    if (scope === 'project') addProjectAsset(meta);
    else addAsset(meta);
  };

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
        window.alert(t('assets.openFolderFailed', { path: winPath }));
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
    if (!window.confirm(t('assets.deleteConfirm', { count: selectedIds.size, names }))) return;
    list.forEach((a) => doRemove(a.id));
    setSelectedIds(new Set());
    setSelectAll(false);
    if (inspectAssetId && selectedIds.has(inspectAssetId)) setInspectAsset(null);
    addLog('info', t('assets.bulkDeleted', { count: list.length }));
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
        doAdd(meta);
      }
      setTab('files');
      setSelectedIds(new Set(importedIds));
      addLog('info', t('assets.imported', { count: importedIds.length }));
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
      window.alert(t('assets.exportEmpty'));
      return;
    }
    list.forEach((a) => downloadBlob(a.name, a.content, mimeOf(a.name)));
    addLog('info', t('assets.bulkExported', { count: list.length }));
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
      title={checked ? t('assets.checkboxUnselect') : t('assets.checkboxSelect')}
    >
      {checked && <CheckSquare size={12} className="text-white" />}
    </button>
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部：导入 / 导出 / 文件列表 切换 */}
      <div className="flex shrink-0 border-b border-line">
        {([
          ['files', t('assets.tabFiles')],
          ['import', t('assets.tabImport')],
          ['export', t('assets.tabExport')],
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

      {/* 作用域切换：项目级（跨工作流共享）/ 工作流级 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[11px] text-ink-faint">{t('assets.scope')}</span>
        <div className="flex overflow-hidden rounded border border-line text-[11px]">
          <button
            onClick={() => setScope('workflow')}
            className={`px-2 py-1 ${scope === 'workflow' ? 'bg-accent text-white' : 'text-ink-soft hover:bg-panel-2'}`}
          >
            {t('assets.scopeWorkflow')}
          </button>
          <button
            onClick={() => setScope('project')}
            className={`px-2 py-1 ${scope === 'project' ? 'bg-accent text-white' : 'text-ink-soft hover:bg-panel-2'}`}
          >
            {t('assets.scopeProject')}
          </button>
        </div>
        <span className="ml-auto text-[11px] text-ink-faint">
          {scope === 'project' ? t('assets.scopeProjectHint') : t('assets.scopeWorkflowHint')}
        </span>
      </div>

      {/* 第二行：多选键（左）+ 搜索栏（右） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          onClick={toggleMulti}
          className={`sm-btn shrink-0 ${multiMode ? 'border-accent text-accent' : ''}`}
          title={
            !multiMode
              ? t('assets.multiEnter')
              : !selectAll
                ? t('assets.multiThenAll')
                : t('assets.multiThenCancel')
          }
        >
          {!multiMode ? <ListChecks size={13} /> : selectAll ? <CheckSquare size={13} /> : <Square size={13} />}
          {multiMode ? (selectAll ? t('assets.multiSelectAll') : t('assets.multiMode')) : t('assets.multiMode')}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('assets.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        {query && (
          <button className="sm-btn shrink-0" onClick={() => setQuery('')}>
            {t('assets.clear')}
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
          <p className="px-3 py-4 text-xs text-ink-faint">{t('assets.needWorkflow')}</p>
        ) : assetList.length === 0 ? (
          <div className="px-3 py-4 text-xs text-ink-faint">
            <p>{t('assets.empty')}</p>
            <p className="mt-1">{t('assets.emptyHint')}</p>
          </div>
        ) : visibleAssets.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">{t('assets.noMatch', { query })}</p>
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
                  {a.inWorkspace ? t('assets.inWorkspace') : t('assets.inWorkflow')} · {formatBytes(a.content)}
                </span>
              </span>
              {a.path && isTauri && (
                <button
                  className="sm-btn shrink-0 border-transparent px-1 text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
                  title={t('assets.openInExplorer')}
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
          {t('assets.exportBtn')}{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
        </button>
        <button
          className={`sm-btn flex-1 justify-center ${multiMode && selectedIds.size > 0 ? 'text-err hover:border-err' : ''}`}
          disabled={!multiMode || selectedIds.size === 0}
          onClick={handleBulkRemove}
        >
          <Trash2 size={13} />
          {t('assets.deleteBtn')}{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
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
