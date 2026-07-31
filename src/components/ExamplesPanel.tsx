import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';

/** 示例库：展示所有场景模板，点击即可载入画布 */
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
          挑一个场景模板，点击「使用」即可载入。所有 AI 模板默认开启离线模拟，无需配置模型也能试跑。
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {STARTER_TEMPLATES.map((t) => (
          <div
            key={t.id}
            className="rounded-xl border p-3"
            style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
          >
            <div className="flex items-start gap-2.5">
              <span className="text-[20px] leading-none">{t.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                  {t.name}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                  {t.desc}
                </p>
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => apply(t.id)}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors"
                style={{ background: 'var(--sm-accent)', color: 'var(--sm-accent-ink)' }}
              >
                使用此模板
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
