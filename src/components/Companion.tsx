import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkflowStore } from '../store/workflowStore';
import { stopWorkflow } from '../engine/executor';
import type { CostRecord, NodeUsageStat } from '../types';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Coins,
  Gauge,
  RotateCcw,
  X,
} from 'lucide-react';
import { useT } from '../i18n/useT';

const POS_KEY = 'sm.companion.pos';
const OPEN_KEY = 'sm.companion.open';

type Pos = { x: number; y: number };

/** 聚合成本账本：按节点汇总 token 消耗 */
function summarizeLedger(costLog: CostRecord[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let calls = 0;
  let errors = 0;
  const byNode = new Map<string, { label: string; in: number; out: number; calls: number }>();
  for (const r of costLog) {
    calls += 1;
    if (!r.ok) errors += 1;
    const u = r.usage;
    const inp = u?.promptTokens ?? 0;
    const out = u?.completionTokens ?? 0;
    const cch = u?.cachedPromptTokens ?? 0;
    inputTokens += inp;
    outputTokens += out;
    cachedTokens += cch;
    const agg = byNode.get(r.nodeId) ?? { label: r.nodeLabel, in: 0, out: 0, calls: 0 };
    agg.in += inp;
    agg.out += out;
    agg.calls += 1;
    byNode.set(r.nodeId, agg);
  }
  const top = [...byNode.entries()]
    .map(([id, v]) => ({ id, ...v, total: v.in + v.out }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  return { inputTokens, outputTokens, cachedTokens, calls, errors, top };
}

/**
 * Companion 浮窗（受 oh-my-opencode-slim 的 Companion 概念启发）：
 * 常驻桌面浮窗，展示运行态、实时进度与各节点 token 消耗。
 * - 用 createPortal 渲染到 body 避免 React Flow 的 overflow:hidden 裁切。
 * - 可拖动，位置持久化到 localStorage。
 * - 运行结束后仍保留最近一次统计，可手动收起/重置。
 */
export default function Companion() {
  const t = useT('panels');
  const running = useWorkflowStore((s) => s.running);
  const runProgress = useWorkflowStore((s) => s.runProgress);
  const costLog = useWorkflowStore((s) => s.costLog);
  const nodes = useWorkflowStore((s) => s.nodes);
  const resetUsage = useWorkflowStore((s) => s.resetUsage);

  const [pos, setPos] = useState<Pos>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) return JSON.parse(raw) as Pos;
    } catch {
      /* ignore */
    }
    return { x: window.innerWidth - 300, y: 80 };
  });
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const dragMoved = useRef(false);

  // 进入运行状态自动展开；位置持久化
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open]);
  useEffect(() => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }, [pos]);

  const summary = useMemo(() => summarizeLedger(costLog), [costLog]);

  // 补充：从节点 data.usage 兜底汇总（若 costLog 未含该节点）
  const nodeUsageTotal = useMemo(() => {
    let calls = 0;
    let tokens = 0;
    for (const n of nodes) {
      const u = n.data.usage as NodeUsageStat | undefined;
      if (u) {
        calls += u.calls ?? 0;
        tokens += (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
      }
    }
    return { calls, tokens };
  }, [nodes]);

  if (!open) {
    // 收起的迷你状态球，点击可展开
    return createPortal(
      <button
        className="sm-companion__bubble"
        style={{ left: pos.x, top: pos.y }}
        title={t('companion.bubbleTitle')}
        onClick={() => setOpen(true)}
        onPointerDown={(e) => startDrag(e)}
      >
        <Activity size={16} color={running ? '#2e9e5b' : '#9aa0a6'} />
      </button>,
      document.body,
    );
  }

  function startDrag(e: React.PointerEvent) {
    dragMoved.current = false;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      dragMoved.current = true;
      setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const totalTokens = summary.inputTokens + summary.outputTokens + nodeUsageTotal.tokens;

  return createPortal(
    <div
      className="sm-companion nowheel"
      style={{ left: pos.x, top: pos.y, width: collapsed ? 220 : 296 }}
      onPointerDown={(e) => {
        // 仅标题栏拖动
        if ((e.target as HTMLElement).closest('.sm-companion__titlebar')) startDrag(e);
      }}
    >
      <div className="sm-companion__titlebar">
        <span className="sm-companion__title">
          <Activity size={13} color={running ? '#2e9e5b' : '#9aa0a6'} />
          {t('companion.title')}
          {running && <span className="sm-companion__live"> {t('companion.live')}</span>}
        </span>
        <span className="sm-companion__actions">
          <button title={collapsed ? t('companion.expand') : t('companion.collapse')} onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button title={t('companion.reset')} onClick={() => resetUsage()}>
            <RotateCcw size={13} />
          </button>
          <button title={t('companion.hide')} onClick={() => setOpen(false)}>
            <X size={13} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="sm-companion__body">
          <div className="sm-companion__metrics">
            <Metric
              icon={<Coins size={12} />}
              label={t('companion.metricTokens')}
              value={totalTokens.toLocaleString()}
            />
            <Metric
              icon={<Gauge size={12} />}
              label={t('companion.metricCalls')}
              value={String(summary.calls + nodeUsageTotal.calls)}
            />
            <Metric
              icon={<Activity size={12} />}
              label={t('companion.metricLayer')}
              value={`${runProgress.layer}/${runProgress.totalLayers || '-'}`}
            />
          </div>

          {running && (
            <div className="sm-companion__progress">
              <div
                className="sm-companion__bar"
                style={{
                  width:
                    runProgress.totalLayers > 0
                      ? `${Math.round((runProgress.layer / runProgress.totalLayers) * 100)}%`
                      : running
                        ? '40%'
                        : '0%',
                }}
              />
            </div>
          )}

          {summary.errors > 0 && (
            <div className="sm-companion__warn">⚠ {summary.errors} {t('companion.errors')}</div>
          )}

          <div className="sm-companion__sec">{t('companion.topTitle')}</div>
          {summary.top.length === 0 ? (
            <div className="sm-companion__empty">{t('companion.empty')}</div>
          ) : (
            <div className="sm-companion__list">
              {summary.top.map((t) => (
                <div key={t.id} className="sm-companion__row">
                  <span className="sm-companion__rowlabel" title={t.label}>
                    {t.label}
                  </span>
                  <span className="sm-companion__tok">{t.total.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {running && (
            <button className="sm-companion__stop" onClick={() => stopWorkflow()}>
              {t('companion.stop')}
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="sm-companion__metric">
      <span className="sm-companion__metricicon">{icon}</span>
      <span className="sm-companion__metricval">{value}</span>
      <span className="sm-companion__metriclabel">{label}</span>
    </div>
  );
}
