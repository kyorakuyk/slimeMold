import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';

const statusLabel: Record<string, string> = {
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  running: '运行中',
};
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

export default function RunHistoryPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const clearRunHistory = useWorkflowStore((s) => s.clearRunHistory);
  const [selectedId, setSelectedId] = useState<string | null>(runHistory[0]?.id ?? null);

  const selected = runHistory.find((r) => r.id === selectedId) ?? null;

  const body = (
    <div className="flex min-h-0 flex-1">
      {/* 左侧：运行列表 */}
      <div className="w-[210px] shrink-0 overflow-y-auto border-r border-line bg-paper-soft">
        {runHistory.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">还没有运行记录</p>
        ) : (
          runHistory.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`block w-full border-b border-line px-3 py-2 text-left transition-colors ${
                selectedId === r.id ? 'bg-accent-soft/30' : 'hover:bg-white'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${statusCls[r.status]}`}>
                  {statusLabel[r.status]}
                </span>
                <span className="text-[10px] text-ink-faint">{r.nodeCount} 节点</span>
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

      {/* 右侧：详情 */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        {!selected ? (
          <p className="text-xs text-ink-faint">选择一次运行以查看节点结果</p>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-line p-2 text-xs text-ink-soft">
              <div>
                状态：<span className={statusCls[selected.status]}>{statusLabel[selected.status]}</span>
              </div>
              <div>耗时：{(selected.durationMs / 1000).toFixed(1)} 秒</div>
              <div>开始：{new Date(selected.startedAt).toLocaleString()}</div>
              {selected.cost ? (
                <div className="mt-1 border-t border-line pt-1 text-ink">
                  <div>
                    总 Token：
                    <span className="font-semibold tabular-nums">
                      {selected.cost.totalTokens.toLocaleString()}
                    </span>
                    <span className="text-ink-faint">
                      {' '}（in {selected.cost.totalPromptTokens.toLocaleString()} / out{' '}
                      {selected.cost.totalCompletionTokens.toLocaleString()}）
                    </span>
                  </div>
                  <div>
                    LLM 调用：<span className="font-semibold tabular-nums">{selected.cost.records.length}</span>
                    {' · '}模型{' '}
                    <span className="font-semibold tabular-nums">{Object.keys(selected.cost.byModel).length}</span> 种
                  </div>
                  <div>
                    Token 耗时：
                    <span className="font-semibold tabular-nums">
                      {(selected.cost.totalDurationMs / 1000).toFixed(1)}
                    </span>{' '}
                    秒
                  </div>
                </div>
              ) : (
                <div className="mt-1 border-t border-line pt-1 text-ink-faint">本次运行无 LLM 成本记录</div>
              )}
            </div>

            {selected.cost && Object.keys(selected.cost.byModel).length > 0 && (
              <div className="rounded border border-line p-2 text-xs">
                <div className="mb-1 font-medium text-ink">按模型拆解（性价比）</div>
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
                        <span className="rounded bg-paper px-1 text-[10px] text-accent" title="结果来自缓存（未实际执行）">
                          缓存
                        </span>
                      ) : n.status === 'skipped' ? (
                        <span className="rounded bg-paper px-1 text-[10px] text-ink-faint" title="因分支条件未命中而跳过">
                          跳过
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
                    <p className="mt-1 text-[11px] text-ink-faint">无输出</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

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
            <h2 className="text-sm font-semibold text-ink">运行历史</h2>
            <span className="text-xs text-ink-faint">（最近 {runHistory.length} 次）</span>
          </div>
          <div className="flex items-center gap-1">
            {runHistory.length > 0 && (
              <button
                className="sm-btn text-err hover:border-err"
                onClick={clearRunHistory}
                title="清空历史"
              >
                <Trash2 size={14} /> 清空
              </button>
            )}
            <button className="sm-btn border-transparent px-1.5" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
