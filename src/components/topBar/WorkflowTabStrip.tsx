import { FileBox, FolderOpen, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

type TFn = (key: string, vars?: Record<string, unknown>) => string;

export interface WorkflowTabStripProps {
  projectName: string | null;
  projectDirty: boolean;
  wfList: Array<[string, { name: string }]>;
  activeWfId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSwitch: (id: string) => void;
  onRename: (name: string) => void;
  onRemove: (id: string) => void;
  onNewWorkflow: () => void;
  replayMode?: boolean;
  t: TFn;
  /** 右侧动作按钮（保持与原内联 JSX 相同的 DOM 层级：位于同一条 workflow-bar 内） */
  children?: ReactNode;
}

/**
 * 工具条：项目面包屑 + 工作流标签浏览器 + 新建按钮。
 * 从 TopBar 抽出，props 驱动，行为与原内联 JSX 一致。
 */
export default function WorkflowTabStrip({
  projectName,
  projectDirty,
  wfList,
  activeWfId,
  editingId,
  setEditingId,
  onSwitch,
  onRename,
  onRemove,
  onNewWorkflow,
  replayMode = false,
  t,
  children,
}: WorkflowTabStripProps) {
  return (
    <div className="sm-pro-workflow-bar flex h-11 items-center gap-2 border-t px-3" style={{ borderColor: 'var(--sm-line)' }}>
      {/* 项目名 + 脏标记 */}
      <div className="sm-pro-project-crumb flex shrink-0 items-center gap-1 pr-2" style={{ borderRight: '1px solid var(--sm-line)' }}>
        <FolderOpen size={13} className="text-ink-faint" />
        <span className="max-w-[160px] truncate text-[12.5px] font-medium" title={projectName ?? t('topbar.untitledProject')}>
          {projectName ?? t('topbar.untitledProject')}
        </span>
        {projectDirty && (
          <span className="text-[13px] leading-none text-err" title={t('topbar.dirtyMark')}>
            *
          </span>
        )}
      </div>
      {/* 标签条 + 新建加号 */}
      <div className="sm-pro-workflow-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {wfList.map(([id, wf]) => {
          const active = id === activeWfId;
          return (
            <div
              key={id}
              className="sm-pro-workflow-tab group flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5"
              data-active={active}
              style={{
                borderColor: active ? 'var(--sm-accent)' : 'transparent',
                background: active ? 'color-mix(in srgb, var(--sm-accent) 8%, transparent)' : 'transparent',
                color: active ? 'var(--sm-accent)' : 'var(--sm-ink-soft)',
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'var(--sm-bg)';
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
            >
              {editingId === id && !replayMode ? (
                <input
                  autoFocus
                  className="w-24 bg-transparent text-[12.5px] outline-none"
                  defaultValue={wf.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v) onRename(v);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  className="flex min-w-0 items-center gap-1.5 truncate text-[12.5px]"
                  disabled={replayMode}
                  onClick={() => {
                    if (!replayMode) onSwitch(id);
                  }}
                  onDoubleClick={() => {
                    if (replayMode) return;
                    onSwitch(id);
                    setEditingId(id);
                  }}
                  title={wf.name}
                >
                  <FileBox size={12} />
                  <span className="truncate">{wf.name}</span>
                </button>
              )}
              <button
                className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-err"
                title={t('topbar.closeWorkflow')}
                disabled={replayMode}
                onClick={(e) => {
                  if (replayMode) return;
                  e.stopPropagation();
                  onRemove(id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-faint transition-colors hover:bg-black/10 hover:text-ink"
          title={projectName ? t('topbar.newWorkflowHint') : t('topbar.newWorkflowHintFree')}
          disabled={replayMode}
          onClick={() => {
            if (!replayMode) onNewWorkflow();
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}
