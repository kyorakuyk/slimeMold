import { useMemo, useState } from 'react';
import { History, Lightbulb, Sparkles, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { getNodeDef } from '../store/registryStore';
import type { FlowNode, FlowEdge } from '../types';

/** 一条历史推荐模板：从多次成功运行中挖掘出的高频节点链 */
interface SuggestTemplate {
  key: string;
  typeIds: string[];
  names: string[];
  count: number; // 出现次数
  avgTokens: number; // 平均 token 消耗（来自成本聚合）
  avgDurationMs: number; // 平均耗时
}

/**
 * 历史模板推荐（受 oh-my-opencode-slim 的「从历史提炼可复用模式」启发）：
 * 扫描运行历史中「成功」的工作流，提取高频出现的节点类型链，
 * 作为可一键复用的子图草稿推荐给用户。
 * - 仅在「节点库」面板底部展示，没有历史或无高频模式时显示空态。
 * - 点击「生成草稿」按该模式的节点顺序用内置定义重建最小图并载入画布。
 */
export default function TemplateSuggestions() {
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const [open, setOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const suggestions = useMemo<SuggestTemplate[]>(() => {
    try {
      // 防御：runHistory 可能含旧格式/脏数据（字段缺失），逐个容错，避免单个坏记录崩溃整个面板
      const successes = runHistory.filter((r) => r && r.status === 'success' && Array.isArray(r.nodes) && r.nodes.length > 1);
      if (successes.length === 0) return [];
      const byKey = new Map<string, SuggestTemplate>();
      for (const rec of successes) {
        const nodes = (rec.nodes ?? []).filter((n) => n && typeof n === 'object');
        const seq = nodes.map((n) => n.typeId).filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (seq.length === 0) continue;
        // 折叠连续重复（如多个 input.text 视为一类），保留结构特征
        const collapsed = seq.filter((t, i) => i === 0 || t !== seq[i - 1]);
        const key = collapsed.join(' › ');
        const names = nodes.map((n) => n.label || getNodeDef(n.typeId)?.name || n.typeId || '未命名');
        const prev = byKey.get(key);
        const tokens = rec.cost?.totalTokens ?? 0;
        if (prev) {
          prev.count += 1;
          prev.avgTokens = Math.round((prev.avgTokens * (prev.count - 1) + tokens) / prev.count);
          prev.avgDurationMs = Math.round(
            (prev.avgDurationMs * (prev.count - 1) + (rec.durationMs ?? 0)) / prev.count,
          );
        } else {
          byKey.set(key, {
            key,
            typeIds: collapsed,
            names,
            count: 1,
            avgTokens: tokens,
            avgDurationMs: rec.durationMs ?? 0,
          });
        }
      }
      // 仅保留出现 ≥2 次的高频模式，按次数降序
      return Array.from(byKey.values())
        .filter((t) => t.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
    } catch {
      // 任何解析异常都不影响节点库面板本身
      return [];
    }
  }, [runHistory]);

  if (runHistory.length === 0) {
    return (
      <div className="mt-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
        <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
          <Lightbulb size={13} style={{ color: 'var(--sm-accent)' }} />
          历史模板推荐
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
          运行过的工作流会在此沉淀为可复用模板。先跑通一个工作流试试吧。
        </p>
      </div>
    );
  }

  const buildDraftFrom = (tpl: SuggestTemplate) => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const ids: string[] = [];
    // 横向排布，相邻节点用各自的第一个输出 → 下一个第一个输入相连
    tpl.typeIds.forEach((typeId, i) => {
      const def = getNodeDef(typeId);
      const id = `tpl-${crypto.randomUUID().slice(0, 8)}`;
      ids.push(id);
      nodes.push({
        id,
        type: 'base',
        position: { x: 80 + i * 240, y: 120 },
        data: { typeId, label: def?.name ?? typeId, params: {}, status: 'idle' },
      } as FlowNode);
      if (i > 0 && def && ids.length >= 2) {
        const prevDef = getNodeDef(tpl.typeIds[i - 1]);
        const sh = prevDef?.outputs[0]?.id ?? 'out';
        const th = def.inputs[0]?.id ?? 'in';
        edges.push({
          id: `e-${ids[i - 1]}-${id}`,
          source: ids[i - 1],
          target: id,
          sourceHandle: sh,
          targetHandle: th,
        } as FlowEdge);
      }
    });
    loadGraph(`推荐：${tpl.names.join(' → ')}`, nodes, edges, []);
    setToast('已生成草稿，可在画布中调整');
    setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className="mt-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
      <button
        className="flex w-full items-center gap-1.5 text-[12px] font-semibold"
        style={{ color: 'var(--sm-ink)' }}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Lightbulb size={13} style={{ color: 'var(--sm-accent)' }} />
        历史模板推荐
        <span className="ml-auto text-[10px] normal-case" style={{ color: 'var(--sm-ink-faint)' }}>
          高频模式
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {suggestions.length === 0 && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
              暂无重复出现的高频模式（需 ≥2 次成功运行且结构相似）。
            </p>
          )}
          {suggestions.map((tpl) => (
            <div
              key={tpl.key}
              className="rounded-md border px-2.5 py-2"
              style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-soft)' }}
            >
              <div className="flex items-center gap-1.5">
                <History size={11} style={{ color: 'var(--sm-ink-faint)' }} />
                <span className="truncate text-[11.5px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                  {tpl.names.join(' → ')}
                </span>
                <span
                  className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ background: 'var(--sm-accent-soft)', color: 'var(--sm-accent)' }}
                >
                  ×{tpl.count}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                <span>≈ {tpl.avgTokens.toLocaleString()} tokens</span>
                <span>{(tpl.avgDurationMs / 1000).toFixed(1)}s</span>
              </div>
              <button
                onClick={() => buildDraftFrom(tpl)}
                className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition-colors"
                style={{ background: 'var(--sm-accent)', color: '#fff' }}
              >
                <Plus size={11} />
                生成草稿
              </button>
            </div>
          ))}
          {suggestions.length > 0 && (
            <p className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
              <Sparkles size={10} />
              从你的成功运行中提炼，越用越懂你
            </p>
          )}
        </div>
      )}
      {toast && (
        <div
          className="mt-2 rounded-md px-2 py-1.5 text-[11px]"
          style={{ background: 'var(--sm-ok-soft)', color: 'var(--sm-ok)' }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
