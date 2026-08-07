import { useEffect, useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { getRunBus } from '../engine/runEvents';
import { applyRunEvent, initialBoardState, replayBoardState } from '../engine/runBoard';
import type { NodeStatus } from '../types';
import { CheckCircle2, XCircle, Loader2, Circle, Zap, SkipForward } from 'lucide-react';
import { useT } from '../i18n/useT';

const statusIcon: Record<NodeStatus, JSX.Element> = {
  idle: <Circle size={11} />,
  running: <Loader2 size={11} className="animate-spin" />,
  success: <CheckCircle2 size={11} />,
  error: <XCircle size={11} />,
  cached: <Zap size={11} />,
  skipped: <SkipForward size={11} />,
  bypassed: <SkipForward size={11} />,
  muted: <Circle size={11} />,
};

const statusColor: Record<NodeStatus, string> = {
  idle: '#9aa0a6',
  running: '#3b82f6',
  success: '#2e9e5b',
  error: '#e0524d',
  cached: '#b07cff',
  skipped: '#9aa0a6',
  bypassed: '#9aa0a6',
  muted: '#9aa0a6',
};

/**
 * 运行期调度看板（Job Board）：浮于画布右上角。
 *
 * A2 改造：不再直接读 store 的 runStates / runProgress / nodes[].data.status，
 * 而是订阅统一事件总线（runEvents），经 runBoard 纯归约出本次运行的渲染快照。
 * 数据源单一（executor 生产的 run.*/node.* 事件），UI 不再猜测零散字段。
 *
 * - 拓扑分层进度（第 N / 总层）、循环轮次（第 R / 总轮）来自 run.progress 事件
 * - 节点状态汇总/列表来自 node.started / node.completed / node.failed / node.skipped
 * - 挂载即同步：回放事件总线历史中当前 wfId 最近一次运行
 */
export default function JobBoard({ wfId }: { wfId?: string }) {
  const t = useT('panels');
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const id = wfId ?? activeWfId ?? '';
  const [board, setBoard] = useState(() => initialBoardState(id));

  // wfId 变化（含 activeWfId 切换）时重置看板
  useEffect(() => {
    setBoard(initialBoardState(id));
  }, [id]);

  // 订阅事件流：挂载即回放当前 wfId 最近一次运行，其后实时增量归约
  useEffect(() => {
    if (!id) return;
    const bus = getRunBus();
    setBoard(replayBoardState(id, bus.history(id)));
    const off = bus.subscribe((e) => {
      setBoard((prev) => applyRunEvent(prev, e));
    });
    return off;
  }, [id]);

  if (!board.running) return null;

  const nodes = Object.entries(board.nodes).map(([nodeId, n]) => ({ id: nodeId, ...n }));
  const counts: Record<NodeStatus, number> = {
    idle: 0, running: 0, success: 0, error: 0, cached: 0, skipped: 0, bypassed: 0, muted: 0,
  };
  for (const n of nodes) {
    const st = n.status as NodeStatus;
    counts[st] = (counts[st] ?? 0) + 1;
  }

  const total = board.nodeCount || nodes.length || 1;
  const done = counts.success + counts.cached + counts.skipped + counts.error;
  const pct = Math.round((done / total) * 100);

  // 仅展示「非 idle」或「运行中」的节点，避免列表过长
  const activeNodes = nodes.filter((n) => n.status && n.status !== 'idle');

  const statusLabel: Record<NodeStatus, string> = {
    idle: t('jobboard.status.idle'),
    running: t('jobboard.status.running'),
    success: t('jobboard.status.success'),
    error: t('jobboard.status.error'),
    cached: t('jobboard.status.cached'),
    skipped: t('jobboard.status.skipped'),
    bypassed: t('jobboard.status.bypassed'),
    muted: t('jobboard.status.muted'),
  };

  return (
    <div className="sm-jobboard nowheel">
      <div className="sm-jobboard__head">
        <span className="sm-jobboard__title">{t('jobboard.title')}</span>
        {board.progress.totalRounds > 1 && (
          <span className="sm-jobboard__round">
            {t('jobboard.round', { round: board.progress.round, total: board.progress.totalRounds })}
          </span>
        )}
      </div>

      <div className="sm-jobboard__progress">
        <div className="sm-jobboard__bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="sm-jobboard__meta">
        {t('jobboard.meta', {
          layer: board.progress.layer,
          totalLayers: board.progress.totalLayers,
          done,
          nodes: total,
        })}
      </div>

      <div className="sm-jobboard__stats">
        {(Object.keys(statusLabel) as NodeStatus[]).map((st) =>
          counts[st] > 0 ? (
            <span
              key={st}
              className="sm-jobboard__chip"
              style={{ color: statusColor[st] }}
              title={statusLabel[st]}
            >
              {statusIcon[st]}
              {counts[st]}
            </span>
          ) : null,
        )}
      </div>

      {activeNodes.length > 0 && (
        <div className="sm-jobboard__list">
          {activeNodes.map((n) => {
            const st = (n.status ?? 'idle') as NodeStatus;
            return (
              <div key={n.id} className="sm-jobboard__row">
                <span style={{ color: statusColor[st] }}>
                  {statusIcon[st]}
                </span>
                <span className="sm-jobboard__rowlabel" title={n.label}>
                  {n.label || n.typeId}
                </span>
                {n.durationMs != null && st !== 'running' && (
                  <span className="sm-jobboard__dur">
                    {(n.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
