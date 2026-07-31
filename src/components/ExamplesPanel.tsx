import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';

/** 示例库：展示所有场景模板，点击卡片即可载入画布 */
export default function ExamplesPanel({ embedded }: { embedded?: boolean }) {
  const loadGraph = useWorkflowStore((s) => s.loadGraph);

  const apply = (id: string) => {
    const tpl = STARTER_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const { nodes, edges } = tpl.build();
    loadGraph('示例 · ' + tpl.name, nodes, edges, [], []);
  };

  return (
    <div className={`flex flex-col ${embedded ? 'h-full' : ''}`}>
      <div className="px-3 pt-3">
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
          挑一个场景模板，点击卡片即可载入。所有 AI 模板默认开启离线模拟，无需配置模型也能试跑。
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="grid grid-cols-2 gap-2.5">
          {STARTER_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => apply(t.id)}
              className="group flex flex-col rounded-xl border p-3 text-left transition-all duration-150 hover:-translate-y-0.5"
              style={{
                background: 'var(--sm-bg-soft)',
                borderColor: 'var(--sm-line)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--sm-accent-soft)';
                e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.08)';
                e.currentTarget.style.background = 'color-mix(in srgb, var(--sm-accent) 6%, var(--sm-bg-soft))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--sm-line)';
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.background = 'var(--sm-bg-soft)';
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[18px] leading-none">{t.emoji}</span>
                <span className="text-[12.5px] font-semibold leading-tight" style={{ color: 'var(--sm-ink)' }}>
                  {t.name}
                </span>
              </div>
              <p className="mt-1.5 line-clamp-3 text-[11px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                {t.desc}
              </p>
              <span
                className="mt-2 inline-flex w-fit items-center gap-1 text-[11px] font-medium opacity-70 transition-opacity group-hover:opacity-100"
                style={{ color: 'var(--sm-accent)' }}
              >
                使用此模板 →
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
