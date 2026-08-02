import { useState } from 'react';
import { FolderPlus, MapPin, FileStack, Check, Sparkles } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { starterTemplates } from '../data/starterTemplates';
import { isTauri, showSaveDirDialog } from '../platform/env';

export default function NewProjectModal({ onClose }: { onClose: () => void }) {
  const createProject = useWorkflowStore((s) => s.createProject);

  const [name, setName] = useState('未命名项目');
  const [templateId, setTemplateId] = useState<string>(''); // '' = 空白画布
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = name.trim().length > 0;
  const tpl = templateId ? starterTemplates.find((t) => t.id === templateId) : undefined;

  const chooseLocation = async () => {
    if (!isTauri) return;
    const picked = await showSaveDirDialog(name.trim() || '未命名项目');
    if (picked) setLocation(picked);
  };

  const confirm = async () => {
    if (!nameValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createProject({ name: name.trim(), templateId: templateId || undefined, location: location ?? undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'color-mix(in srgb, var(--sm-bg) 70%, transparent)' }}>
      <div
        className="relative flex max-h-[88vh] w-[760px] max-w-full flex-col rounded-2xl border p-6 shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
      >
        <button
          className="absolute right-3 top-3 rounded-md p-1.5 transition-colors hover:bg-[var(--sm-bg-soft)]"
          style={{ color: 'var(--sm-ink-faint)' }}
          title="关闭"
          onClick={onClose}
        >
          <FileStack size={16} />
        </button>

        <div className="flex items-center gap-2">
          <FolderPlus size={20} style={{ color: 'var(--sm-accent)' }} />
          <h2 className="text-[18px] font-bold" style={{ color: 'var(--sm-ink)' }}>
            新建项目
          </h2>
        </div>

        {/* 1. 项目名 */}
        <label className="mt-4 block text-[12px] font-semibold" style={{ color: 'var(--sm-ink-soft)' }}>
          项目名称
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
          placeholder="给我的自动化起个名字"
          className="mt-1.5 w-full rounded-lg border px-3 py-2 text-[13px] outline-none focus:border-[var(--sm-accent)]"
          style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)', color: 'var(--sm-ink)' }}
        />

        {/* 2. 起始模板 */}
        <div className="mt-4 flex items-center gap-1.5">
          <Sparkles size={13} style={{ color: 'var(--sm-accent)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--sm-ink-soft)' }}>
            起始模板
          </span>
          <span className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
            （可选，选「空白画布」则从零开始）
          </span>
        </div>
        <div className="mt-2 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
          <TemplateCard
            active={templateId === ''}
            title="空白画布"
            desc="从空工作流开始，自由搭建节点。"
            nodeCount={0}
            onClick={() => setTemplateId('')}
          />
          {starterTemplates.map((t) => (
            <TemplateCard
              key={t.id}
              active={templateId === t.id}
              title={`${t.emoji} ${t.name}`}
              desc={t.desc}
              nodeCount={t.build().nodes.length}
              onClick={() => setTemplateId(t.id)}
            />
          ))}
        </div>

        {/* 3. 保存位置（桌面端） */}
        {isTauri && (
          <div className="mt-4">
            <label className="block text-[12px] font-semibold" style={{ color: 'var(--sm-ink-soft)' }}>
              保存位置
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={chooseLocation}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition hover:border-[var(--sm-accent)]"
                style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink)' }}
              >
                <MapPin size={14} style={{ color: 'var(--sm-accent)' }} />
                {location ? '更改位置' : '选择位置…'}
              </button>
              <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: location ? 'var(--sm-ink)' : 'var(--sm-ink-faint)' }}>
                {location ? location : '未选择：新建后需手动保存才能落盘'}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--sm-err)', color: 'var(--sm-err)' }}>
            {error}
          </p>
        )}

        {/* 底部操作 */}
        <div className="mt-5 flex items-center justify-end gap-2">
          {tpl && (
            <span className="mr-auto text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              将载入模板「{tpl.name}」（{tpl.graph.nodes.length} 个节点）
            </span>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-[13px] transition hover:bg-[var(--sm-bg-soft)]"
            style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
          >
            取消
          </button>
          <button
            onClick={confirm}
            disabled={!nameValid || busy}
            className="rounded-lg px-4 py-2 text-[13px] font-medium text-white transition disabled:opacity-50"
            style={{ background: 'var(--sm-accent)' }}
          >
            {busy ? '创建中…' : location ? '创建并保存到磁盘' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  active,
  title,
  desc,
  nodeCount,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  nodeCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex flex-col rounded-xl border p-3 text-left transition"
      style={{
        borderColor: active ? 'var(--sm-accent)' : 'var(--sm-line)',
        background: active ? 'color-mix(in srgb, var(--sm-accent) 8%, var(--sm-bg))' : 'var(--sm-bg-soft)',
      }}
    >
      {active && (
        <span
          className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full text-white"
          style={{ background: 'var(--sm-accent)' }}
        >
          <Check size={11} />
        </span>
      )}
      <span className="text-[13px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
        {title}
      </span>
      <span className="mt-1 line-clamp-2 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
        {desc}
      </span>
      <span className="mt-1.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
        {nodeCount > 0 ? `${nodeCount} 个节点` : '空工作流'}
      </span>
    </button>
  );
}
