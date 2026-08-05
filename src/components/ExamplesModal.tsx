import { useEffect } from 'react';
import { X } from 'lucide-react';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

/** 示例库次级窗口：居中弹窗，模板以网格排列，超出部分滚轮滚动 */
export default function ExamplesModal({ onClose }: { onClose: () => void }) {
  const t = useT('modals');
  const loadGraph = useWorkflowStore((s) => s.loadGraph);

  const apply = (id: string) => {
    const tpl = STARTER_TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    const { nodes, edges } = tpl.build();
    loadGraph(t('examplesModal.prefix') + tpl.name, nodes, edges, [], []);
    onClose();
  };

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'color-mix(in srgb, #000 45%, transparent)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[min(80vh,640px)] w-[min(92vw,760px)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div
          className="flex h-12 shrink-0 items-center justify-between border-b px-4"
          style={{ borderColor: 'var(--sm-line)' }}
        >
          <div>
            <p className="text-[14px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
              {t('examplesModal.title')}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('examplesModal.subtitle')}
            </p>
          </div>
          <button
            className="cursor-pointer rounded-md p-1 transition-colors"
            style={{ color: 'var(--sm-ink-faint)' }}
            onClick={onClose}
            title={t('common.close')}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sm-bg-deep)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 滚动内容区：超出的模板用滚轮查看 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STARTER_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => apply(tpl.id)}
                className="group flex flex-col rounded-xl border p-3 text-left transition-all duration-150 hover:-translate-y-0.5"
                style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--sm-accent-soft)';
                  e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.10)';
                  e.currentTarget.style.background =
                    'color-mix(in srgb, var(--sm-accent) 6%, var(--sm-bg-soft))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--sm-line)';
                  e.currentTarget.style.boxShadow = 'none';
                  e.currentTarget.style.background = 'var(--sm-bg-soft)';
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[20px] leading-none">{tpl.emoji}</span>
                  <span className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--sm-ink)' }}>
                    {tpl.name}
                  </span>
                </div>
                <p className="mt-2 line-clamp-3 text-[11.5px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                  {tpl.desc}
                </p>
                <span
                  className="mt-2 inline-flex w-fit items-center gap-1 text-[11px] font-medium opacity-70 transition-opacity group-hover:opacity-100"
                  style={{ color: 'var(--sm-accent)' }}
                >
                  {t('examplesModal.use')}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
