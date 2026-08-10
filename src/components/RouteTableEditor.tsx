/**
 * 步骤 14.7：项目级「类别 → 智能体」路由表编辑器。
 * Builder（14.F）据 ModuleItem.category 查此表为 worker 绑定 agent（对齐 OMO category 解耦 + slim 可配模型）。
 *
 * 设计取舍：直接复用 workflowStore 的 agentRouteTable / setAgentRouteTable，UI 仅渲染
 * 固定的 5 个类别行（ui/logic/docs/infra/data），每行为一个 agent 下拉 + 可选 fallback 链，
 * 改动即时写回 store（经由方法，保证脏标记与持久化生效）。
 */
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';
import { mergeAgentPool } from '../agents/globalAgents';

const CATEGORY_KEYS = ['ui', 'logic', 'docs', 'infra', 'data'] as const;

export function RouteTableEditor() {
  const t = useT('panels');
  const agentRouteTable = useWorkflowStore((s) => s.agentRouteTable);
  const setAgentRouteTable = useWorkflowStore((s) => s.setAgentRouteTable);
  const agents = useWorkflowStore((s) => s.agents);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  // 类别下拉候选 = 项目级 ∪ 全局（项目级优先）；全局项用「全局」后缀标识，跨项目仍可用
  const pool = mergeAgentPool(agents, globalAgents);

  const updateEntry = (category: string, patch: { agentId?: string; fallback?: string[] }) => {
    const cur = agentRouteTable[category] ?? {};
    const next = { ...agentRouteTable, [category]: { ...cur, ...patch } };
    setAgentRouteTable(next);
  };

  const fillDefaults = () => {
    const target = defaultAgentId ?? pool[0]?.id;
    if (!target) return;
    const next: Record<string, { agentId: string; fallback?: string[] }> = {};
    for (const c of CATEGORY_KEYS) next[c] = { agentId: target };
    setAgentRouteTable(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-soft">{t('route.title')}</p>
        {defaultAgentId && (
          <button className="sm-btn px-2 py-0.5 text-[11px]" onClick={fillDefaults} title={t('route.fillDefaultsTitle')}>
            {t('route.fillDefaults')}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {CATEGORY_KEYS.map((key) => {
          const entry = agentRouteTable[key] ?? {};
          return (
            <div key={key} className="rounded border border-line bg-white px-2.5 py-2">
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[12px] font-semibold text-ink">{t(`route.cat.${key}`)}</span>
                <span className="text-[10px] opacity-60">{t(`route.cat.${key}Hint`)}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="sm-input min-w-0 flex-1 cursor-pointer text-[12px]"
                  value={entry.agentId ?? ''}
                  onChange={(e) => updateEntry(key, { agentId: e.target.value })}
                >
                  <option value="" disabled>
                    {t('route.unbound')}
                  </option>
                  {pool.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}（{a.model}）{globalAgents.some((g) => g.id === a.id) && !agents.some((p) => p.id === a.id) ? t('route.globalSuffix') : ''}
                    </option>
                  ))}
                </select>
              </div>
              <input
                className="sm-input mt-1.5 w-full text-[12px]"
                placeholder={t('route.fallbackPlaceholder')}
                value={(entry.fallback ?? []).join(', ')}
                onChange={(e) =>
                  updateEntry(key, {
                    fallback: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          );
        })}
      </div>
      {pool.length === 0 && (
        <p className="text-[11px] text-ink-faint">{t('route.noAgents')}</p>
      )}
    </div>
  );
}
