import { useEffect, useState } from 'react';
import {
  FolderPlus,
  FolderOpen,
  FileStack,
  Clock,
  Sparkles,
  X,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import {
  openProjectFile,
  openProjectByPath,
  getRecentProjects,
  clearRecentProjects,
  saveLastSession,
  clearLastSession,
} from '../io/projectIO';
import type { ProjectFile } from '../types';

export default function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [recents, setRecents] = useState(() => getRecentProjects());
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    setRecents(getRecentProjects());
  }, []);

  const openAndTrack = (file: ProjectFile & { path?: string; legacy?: boolean }, path: string) => {
    const st = useWorkflowStore.getState();
    st.openProject(file, path);
    saveLastSession({ path, activeId: st.activeWfId ?? undefined });
    onClose();
  };

  const handleOpen = async () => {
    setLoading('open');
    try {
      const file = await openProjectFile();
      if (!file) return;
      const path = (file as ProjectFile & { path?: string }).path ?? file.name;
      openAndTrack(file, path);
    } finally {
      setLoading(null);
    }
  };

  const handleRecent = async (path: string) => {
    setLoading(path);
    try {
      const file = await openProjectByPath(path);
      if (!file) {
        // 路径失效：从最近列表移除
        clearRecentProjects();
        setRecents(getRecentProjects());
        return;
      }
      openAndTrack(file, path);
    } finally {
      setLoading(null);
    }
  };

  const handleNew = () => {
    const name = window.prompt('项目名称', '未命名项目')?.trim();
    if (!name) return;
    useWorkflowStore.getState().newProject(name);
    clearLastSession();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'color-mix(in srgb, var(--sm-bg) 70%, transparent)' }}>
      <div
        className="relative w-[640px] max-w-full rounded-2xl border p-7 shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
      >
        <button
          className="absolute right-3 top-3 rounded-md p-1.5 transition-colors hover:bg-[var(--sm-bg-soft)]"
          style={{ color: 'var(--sm-ink-faint)' }}
          title="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <div className="flex items-center gap-2">
          <Sparkles size={20} style={{ color: 'var(--sm-accent)' }} />
          <h2 className="text-[20px] font-bold" style={{ color: 'var(--sm-ink)' }}>
            slimeMold
          </h2>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
          把节点连成一条工作流，就能自动运行。选择一个项目开始，或新建一个。
        </p>

        {/* 主操作 */}
        <div className="mt-5 flex flex-col gap-1.5">
          <button
            onClick={handleNew}
            disabled={!!loading}
            className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)] disabled:opacity-50"
            style={{ color: 'var(--sm-ink)' }}
          >
            <FolderPlus size={16} style={{ color: 'var(--sm-accent)' }} />
            新建项目
          </button>
          <button
            onClick={handleOpen}
            disabled={!!loading}
            className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)] disabled:opacity-50"
            style={{ color: 'var(--sm-ink)' }}
          >
            <FolderOpen size={16} style={{ color: 'var(--sm-accent)' }} />
            打开项目…
          </button>
        </div>

        {/* 最近项目 */}
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5">
            <Clock size={13} style={{ color: 'var(--sm-ink-faint)' }} />
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--sm-ink-faint)' }}>
              最近项目
            </span>
            {recents.length > 0 && (
              <button
                className="ml-auto text-[11px] text-[var(--sm-ink-faint)] hover:text-[var(--sm-err)]"
                onClick={() => {
                  clearRecentProjects();
                  setRecents([]);
                }}
              >
                清除
              </button>
            )}
          </div>

          {recents.length === 0 ? (
            <p className="flex items-center gap-2 px-1 py-2 text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
              <FileStack size={14} /> 暂无最近项目
            </p>
          ) : (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {recents.map((r) => (
                <button
                  key={r.path}
                  onClick={() => handleRecent(r.path)}
                  disabled={loading === r.path}
                  className="group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition hover:-translate-y-0.5 disabled:opacity-50"
                  style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--sm-accent-soft)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--sm-line)';
                  }}
                >
                  <FolderOpen size={15} style={{ color: 'var(--sm-accent)' }} />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                      {r.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {r.path}
                    </span>
                  </span>
                  {loading === r.path && (
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      打开中…
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="mt-5 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
          已打开过的项目会在下次启动时自动恢复；此页面仅在无项目加载时出现。
        </p>
      </div>
    </div>
  );
}
