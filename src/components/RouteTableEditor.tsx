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
import { FALLBACK_CATEGORY } from '../agents/agentRouter';
import { AgentSelect } from './AgentSelect';

const CATEGORY_KEYS = ['ui', 'logic', 'docs', 'infra', 'data'] as const;

export function RouteTableEditor() {
  const t = useT('panels');
  const agentRouteTable = useWorkflowStore((s) => s.agentRouteTable);
  const setAgentRouteTable = useWorkflowStore((s) => s.setAgentRouteTable);
  const agents = useWorkflowStore((s) => s.agents);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  // 类别下拉候选 = 项目级 ∪ 全局（项目级优先）；全局项用「全局」后缀标识，跨项目仍可用
  // 含禁用的全池：用于展示已绑定值；主选下拉通过 option disabled 禁止新选禁用项，回退链由 AgentSelect 置灰不可点
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

  /** 渲染单条路由卡片；key 为类别键或兜底保留键（FALLBACK_CATEGORY）。 */
  const renderRow = (category: string) => {
    const isFallback = category === FALLBACK_CATEGORY;
    const entry = agentRouteTable[category] ?? {};
    const bound = pool.find((a) => a.id === entry.agentId);
    const title = isFallback ? t('route.cat.fallback') : t(`route.cat.${category}`);
    const hint = isFallback ? t('route.cat.fallbackHint') : t(`route.cat.${category}Hint`);
    return (
      <div
        key={category}
        className={`rounded-md border bg-paper-soft px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.04)] ${
          isFallback ? 'border-dashed border-ink-faint/40' : 'border-line'
        }`}
      >
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-semibold tracking-wide text-ink">{title}</span>
            <span className="text-[10px] text-ink-faint">{hint}</span>
          </div>
          <span
            className={`shrink-0 text-[10px] ${bound ? 'text-ok' : 'text-ink-faint'}`}
            title={bound ? `${bound.name}（${bound.model}）` : t('route.unbound')}
          >
            {bound ? `● ${bound.name}` : '○ 未绑定'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="sm-input min-w-0 flex-1 cursor-pointer text-[12px]"
            value={entry.agentId ?? ''}
            onChange={(e) => updateEntry(category, { agentId: e.target.value })}
          >
            <option value="" disabled>
              {t('route.unbound')}
            </option>
            {pool.map((a) => (
              <option key={a.id} value={a.id} disabled={a.enabled === false}>
                {a.name}（{a.model}）{globalAgents.some((g) => g.id === a.id) && !agents.some((p) => p.id === a.id) ? t('route.globalSuffix') : ''}
                {a.enabled === false ? t('route.disabledSuffix') : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1.5">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-ink-faint">回退链</span>
            <span className="text-[10px] text-ink-faint">{t('route.fallbackPlaceholder')}</span>
          </div>
          <AgentSelect
            agents={pool}
            multiple
            value={(entry.fallback ?? []).join(',')}
            onChange={(v) =>
              updateEntry(category, {
                fallback: v
                  ? v
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [],
              })
            }
            placeholder={t('route.fallbackPlaceholder')}
          />
        </div>
      </div>
    );
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
      <div className="space-y-2.5">
        {CATEGORY_KEYS.map(renderRow)}
        {/* 兜底路由：当无法推断工作类型（category 为空）或未经 builder 指派时生效 */}
        {renderRow(FALLBACK_CATEGORY)}
      </div>
      {pool.length === 0 && (
        <p className="text-[11px] text-ink-faint">{t('route.noAgents')}</p>
      )}
    </div>
  );
}
