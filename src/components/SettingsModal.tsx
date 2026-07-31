import { useEffect } from 'react';
import { X, Settings as SettingsIcon } from 'lucide-react';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';

/** 设置：悬浮窗口（当前为占位，网格/小地图已接入真实开关） */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { showGrid, showMinimap, toggleGrid, toggleMinimap } = useViewStore();
  const llmChannel = useWorkflowStore((s) => s.llmChannel);
  const setLlmChannel = useWorkflowStore((s) => s.setLlmChannel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Row = ({
    label,
    desc,
    checked,
    onChange,
  }: {
    label: string;
    desc: string;
    checked: boolean;
    onChange: () => void;
  }) => (
    <label className="flex items-center justify-between gap-4 rounded border border-line px-3 py-2.5">
      <span>
        <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          {label}
        </span>
        <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {desc}
        </span>
      </span>
      <button
        type="button"
        onClick={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{
          background: checked ? 'var(--sm-accent)' : 'var(--sm-bg-deep)',
        }}
        title={checked ? '已开启' : '已关闭'}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
          style={{ left: checked ? '18px' : '2px' }}
        />
      </button>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[440px] rounded-lg border p-4 shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            <SettingsIcon size={16} /> 设置
          </h2>
          <button className="sm-btn px-2 py-0.5" onClick={onClose}>
            <X size={14} /> 关闭
          </button>
        </div>

        <div className="space-y-2">
          <Row label="显示网格" desc="画布背景网格点阵" checked={showGrid} onChange={toggleGrid} />
          <Row label="显示小地图" desc="右下角导航小地图" checked={showMinimap} onChange={toggleMinimap} />

          <div className="rounded border border-line px-3 py-2.5">
            <div className="mb-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                LLM 调用通道
              </span>
              <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                后端：经 Rust 命令发起，密钥不出渲染层（推荐）；前端：WebView 直接请求
              </span>
            </div>
            <div className="flex gap-2">
              {([
                { v: 'backend', t: '后端（推荐）' },
                { v: 'frontend', t: '前端' },
              ] as const).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setLlmChannel(opt.v)}
                  className="flex-1 rounded border px-2 py-1.5 text-[12px] transition-colors"
                  style={{
                    borderColor:
                      llmChannel === opt.v ? 'var(--sm-accent)' : 'var(--sm-line)',
                    background:
                      llmChannel === opt.v ? 'var(--sm-accent-soft)' : 'transparent',
                    color: llmChannel === opt.v ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
                  }}
                >
                  {opt.t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-4 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          更多设置项（外观主题、执行引擎、快捷键映射等）将在后续版本补充。
        </p>
      </div>
    </div>
  );
}
