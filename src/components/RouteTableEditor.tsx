/**
 * 步骤 14.7：项目级「类别 → 智能体」路由表编辑器。
 * Builder（14.F）据 ModuleItem.category 查此表为 worker 绑定 agent（对齐 OMO category 解耦 + slim 可配模型）。
 *
 * 设计取舍：直接复用 workflowStore 的 agentRouteTable / setAgentRouteTable，UI 仅渲染
 * 固定的 5 个类别行（ui/logic/docs/infra/data），每行为一个 agent 下拉 + 可选 fallback 链，
 * 改动即时写回 store（经由方法，保证脏标记与持久化生效）。
 */
import { useWorkflowStore } from '../store/workflowStore';

const CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: 'ui', label: 'UI / 前端', hint: '界面、交互、样式' },
  { key: 'logic', label: 'Logic / 逻辑', hint: '核心业务、算法' },
  { key: 'docs', label: 'Docs / 文档', hint: '说明、注释、文档' },
  { key: 'infra', label: 'Infra / 基建', hint: '构建、部署、配置' },
  { key: 'data', label: 'Data / 数据', hint: '存储、接口契约' },
];

export function RouteTableEditor() {
  const agentRouteTable = useWorkflowStore((s) => s.agentRouteTable);
  const setAgentRouteTable = useWorkflowStore((s) => s.setAgentRouteTable);
  const agents = useWorkflowStore((s) => s.agents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);

  const updateEntry = (category: string, patch: { agentId?: string; fallback?: string[] }) => {
    const cur = agentRouteTable[category] ?? {};
    const next = { ...agentRouteTable, [category]: { ...cur, ...patch } };
    setAgentRouteTable(next);
  };

  const fillDefaults = () => {
    const target = defaultAgentId ?? agents[0]?.id;
    if (!target) return;
    const next: Record<string, { agentId: string; fallback?: string[] }> = {};
    for (const c of CATEGORIES) next[c.key] = { agentId: target };
    setAgentRouteTable(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-soft">类别 → 智能体路由（Builder 生成时绑定 worker）</p>
        {defaultAgentId && (
          <button className="sm-btn px-2 py-0.5 text-[11px]" onClick={fillDefaults} title="所有类别绑定到默认智能体">
            一键填充默认
          </button>
        )}
      </div>
      <div className="space-y-2">
        {CATEGORIES.map((c) => {
          const entry = agentRouteTable[c.key] ?? {};
          return (
            <div key={c.key} className="rounded border border-line bg-white px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[12px] font-medium text-ink">{c.label}</span>
                <span className="text-[10px] text-ink-faint">{c.hint}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="sm-input min-w-0 flex-1 cursor-pointer"
                  value={entry.agentId ?? ''}
                  onChange={(e) => updateEntry(c.key, { agentId: e.target.value })}
                >
                  <option value="">— 默认/未绑定 —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}（{a.model}）
                    </option>
                  ))}
                </select>
              </div>
              <input
                className="sm-input mt-1.5 w-full"
                placeholder="回退链（可选，逗号分隔 agentId）"
                value={(entry.fallback ?? []).join(', ')}
                onChange={(e) =>
                  updateEntry(c.key, {
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
      {agents.length === 0 && (
        <p className="text-[11px] text-ink-faint">当前工作流暂无智能体，请先在智能体面板添加。</p>
      )}
    </div>
  );
}
