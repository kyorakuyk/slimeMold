import { useState } from 'react';
import { X, Trash2, RotateCcw } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

const statusCls: Record<string, string> = {
  success: 'text-grn',
  partial: 'text-yel',
  failed: 'text-err',
  running: 'text-accent',
};
const nodeStatusCls: Record<string, string> = {
  success: 'bg-grn',
  partial: 'bg-yel',
  failed: 'bg-err',
  running: 'bg-accent',
  cached: 'bg-accent',
  skipped: 'bg-[#9aa0a6]',
};

function summarize(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return String(v);
  }
}

export default function RunHistoryPanel({
  onClose,
  embedded = false,
  variant = 'center',
}: {
  onClose?: () => void;
  embedded?: boolean;
  /** 'center'（控制中心，默认）= 左列表 + 右详情 inline 左右二分；
   *  'sidebar'（侧边栏）= 列表为一级菜单，详情作 absolute 二级抽屉从右滑入覆盖列表 */
  variant?: 'center' | 'sidebar';
}) {
  const t = useT('panels');
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const clearRunHistory = useWorkflowStore((s) => s.clearRunHistory);
  // 侧边栏默认无选中（点选展开，再点收回）；center 默认选第一条
  const [selectedId, setSelectedId] = useState<string | null>(
    variant === 'sidebar' ? null : (runHistory[0]?.id ?? null),
  );

  const selected = runHistory.find((r) => r.id === selectedId) ?? null;

  const body = (
    <div className={`relative flex min-h-0 flex-1 ${variant === 'sidebar' ? 'overflow-visible' : 'overflow-hidden'}`}>
      {/* 左侧：运行列表（一级菜单） */}
      <div className={
        variant === 'sidebar'
          ? 'min-h-0 w-full shrink-0 overflow-y-auto border-r border-line bg-paper-soft'
          : 'w-[210px] shrink-0 overflow-y-auto border-r border-line bg-paper-soft'
      }>
        {runHistory.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">{t('runHistory.empty')}</p>
        ) : (
          runHistory.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
              className={`block w-full border-b border-line px-3 py-2 text-left transition-colors ${
                selectedId === r.id ? 'border-l-2 border-line bg-paper-soft' : 'border-l-2 border-transparent hover:bg-paper-soft'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${statusCls[r.status]}`}>
                  {t(`runHistory.status.${r.status}`)}
                </span>
                <span className="text-[10px] text-ink-faint">{r.nodeCount} {t('runHistory.nodes')}</span>
              </div>
              <div className="truncate text-xs text-ink" title={r.name}>
                {r.name}
              </div>
              <div className="text-[10px] text-ink-faint">
                {(r.durationMs / 1000).toFixed(1)}s · {new Date(r.startedAt).toLocaleString()}
              </div>
            </button>
          ))
        )}
      </div>

      {/* 右侧：详情
          - center（inline 右栏，默认）：flex-1，左右二分
          - sidebar（absolute 二级抽屉，从面板右滑入）：仅选中时渲染 */}
      {(variant === 'center' || selected) && (
      <div className={
        variant === 'center'
          ? 'min-w-0 flex-1 overflow-y-auto px-4 py-3'
          : 'absolute left-full top-0 z-20 h-full w-[400px] overflow-y-auto border-l border-line bg-paper-soft px-4 py-3 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.25)] animate-in slide-in-from-left duration-200'
      }>
        {!selected ? (
          <p className="text-xs text-ink-faint">{t('runHistory.selectHint')}</p>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-line p-2 text-xs text-ink-soft">
              <div>
                {t('runHistory.status.label')}：<span className={statusCls[selected.status]}>{t(`runHistory.status.${selected.status}`)}</span>
              </div>
              <div>{t('runHistory.duration', { sec: (selected.durationMs / 1000).toFixed(1) })}</div>
              <div>{t('runHistory.start', { time: new Date(selected.startedAt).toLocaleString() })}</div>
              {selected.cost ? (
                <div className="mt-1 border-t border-line pt-1 text-ink">
                  <div>
                    {t('runHistory.totalToken')}
                    <span className="font-semibold tabular-nums">
                      {selected.cost.totalTokens.toLocaleString()}
                    </span>
                    <span className="text-ink-faint">
                      {t('runHistory.tokenInOut', {
                        in: selected.cost.totalPromptTokens.toLocaleString(),
                        out: selected.cost.totalCompletionTokens.toLocaleString(),
                      })}
                    </span>
                  </div>
                  <div>
                    {t('runHistory.llmCalls', {
                      count: selected.cost.records.length,
                      models: Object.keys(selected.cost.byModel).length,
                    })}
                  </div>
                  <div>
                    {t('runHistory.tokenTime', { sec: (selected.cost.totalDurationMs / 1000).toFixed(1) })}
                  </div>
                </div>
              ) : (
                <div className="mt-1 border-t border-line pt-1 text-ink-faint">{t('runHistory.noCost')}</div>
              )}
            </div>

            {selected.cost && Object.keys(selected.cost.byModel).length > 0 && (
              <div className="rounded border border-line p-2 text-xs">
                <div className="mb-1 font-medium text-ink">{t('runHistory.byModel')}</div>
                <div className="space-y-1">
                  {Object.entries(selected.cost.byModel).map(([model, m]) => (
                    <div key={model} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-ink-soft" title={model}>
                        {model}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-faint">
                        {m.promptTokens.toLocaleString()}+{m.completionTokens.toLocaleString()} tok ·{' '}
                        {m.calls} 次
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              {selected.nodes.map((n) => (
                <div key={n.id} className="rounded border border-line p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-ink" title={n.label}>
                      {n.label}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {n.durationMs != null ? (
                        <span
                          className="rounded bg-paper px-1 text-[10px] tabular-nums text-ink-faint"
                          title={`开始：${n.startedAt ? new Date(n.startedAt).toLocaleTimeString() : '—'}`}
                        >
                          {n.durationMs}ms
                        </span>
                      ) : null}
                      {n.cost && n.cost.length > 0 ? (
                        <span
                          className="rounded bg-amber-50 px-1 text-[10px] tabular-nums text-amber-700"
                          title={`模型：${n.cost.map((c) => c.model).join(', ')}；含失败 ${n.cost.filter((c) => !c.ok).length} 次`}
                        >
                          {n.cost
                            .reduce((s, c) => s + (c.usage?.totalTokens ?? 0), 0)
                            .toLocaleString()}{' '}
                          tok
                        </span>
                      ) : null}
                      {n.durationMs != null ? null : n.status === 'cached' ? (
                        <span className="rounded bg-paper px-1 text-[10px] text-accent" title={t('runHistory.cachedTitle')}>
                          {t('runHistory.cached')}
                        </span>
                      ) : n.status === 'skipped' ? (
                        <span className="rounded bg-paper px-1 text-[10px] text-ink-faint" title={t('runHistory.skippedTitle')}>
                          {t('runHistory.skipped')}
                        </span>
                      ) : null}
                      <span className={`h-2 w-2 shrink-0 rounded-full ${nodeStatusCls[n.status]}`} />
                    </div>
                  </div>
                  {n.error ? (
                    <p className="mt-1 break-all text-[11px] leading-relaxed text-err">
                      {n.error}
                    </p>
                  ) : n.outputs ? (
                    <div className="mt-1 space-y-1">
                      {Object.entries(n.outputs).map(([k, v]) => (
                        <p
                          key={k}
                          className="whitespace-pre-wrap break-all rounded bg-paper-soft px-2 py-1 text-[11px] leading-relaxed text-ink-soft"
                        >
                          <span className="text-ink-faint">{k}: </span>
                          {summarize(v)}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-ink-faint">{t('runHistory.noOutput')}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );

  // sidebar 模式：不需要外层弹层（SidePanel 已提供容器），直接返回 body
  if (variant === 'sidebar') return body;
  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative flex h-full w-[560px] flex-col border-l border-line bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">{t('runHistory.title')}</h2>
            <span className="text-xs text-ink-faint">{t('runHistory.recent', { count: runHistory.length })}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="sm-btn hover:border-accent hover:text-accent"
              onClick={() => {
                const ok = useWorkflowStore.getState().restoreCheckpoint();
                useWorkflowStore
                  .getState()
                  .addLog(
                    ok ? 'info' : 'warn',
                    ok ? '已从检查点恢复画布：成功节点复用、失败节点可续跑' : '当前工作流没有可恢复的运行检查点',
                  );
              }}
              title={t('runHistory.restoreTitle')}
            >
              <RotateCcw size={14} /> {t('runHistory.restore')}
            </button>
            {runHistory.length > 0 && (
              <button
                className="sm-btn text-err hover:border-err"
                onClick={clearRunHistory}
                title={t('runHistory.clearTitle')}
              >
                <Trash2 size={14} /> {t('runHistory.clear')}
              </button>
            )}
            <button className="sm-btn border-transparent px-1.5" onClick={onClose} title={t('common.close')}>
              <X size={16} />
            </button>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
