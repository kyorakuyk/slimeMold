import { useWorkflowStore } from '../store/workflowStore';
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
 * 运行期调度看板（Job Board）：浮于画布右上角，展示
 * - 拓扑分层进度（第 N / 总层）
 * - 循环轮次（第 R / 总轮）
 * - 各节点 task 状态汇总（按状态分组计数）
 * 数据来自 workflowStore.runProgress 与 nodes[].data.status。
 */
export default function JobBoard({ wfId }: { wfId?: string }) {
  const s = useWorkflowStore();
  const t = useT('panels');
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
  // 方案 A：按 wfId 隔离运行态；未传则用激活工作流
  const running = wfId ? (s.runStates[wfId]?.running ?? false) : s.running;
  const runProgress = wfId ? (s.runStates[wfId]?.progress ?? s.runProgress) : s.runProgress;
  const nodes = wfId ? (s.workflows[wfId]?.nodes ?? []) : s.nodes;

  if (!running && !runProgress.active) return null;

  const counts: Record<NodeStatus, number> = {
    idle: 0, running: 0, success: 0, error: 0, cached: 0, skipped: 0, bypassed: 0, muted: 0,
  };
  for (const n of nodes) {
    const st = n.data.status ?? 'idle';
    counts[st] = (counts[st] ?? 0) + 1;
  }

  const total = nodes.length || 1;
  const done = counts.success + counts.cached + counts.skipped + counts.error;
  const pct = Math.round((done / total) * 100);

  // 仅展示「非 idle」或「运行中」的节点，避免列表过长
  const activeNodes = nodes.filter(
    (n) => n.data.status && n.data.status !== 'idle',
  );

  return (
    <div className="sm-jobboard nowheel">
      <div className="sm-jobboard__head">
        <span className="sm-jobboard__title">{t('jobboard.title')}</span>
        {runProgress.totalRounds > 1 && (
          <span className="sm-jobboard__round">
            {t('jobboard.round', { round: runProgress.round, total: runProgress.totalRounds })}
          </span>
        )}
      </div>

      <div className="sm-jobboard__progress">
        <div className="sm-jobboard__bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="sm-jobboard__meta">
        {t('jobboard.meta', { layer: runProgress.layer, totalLayers: runProgress.totalLayers, done, nodes: nodes.length })}
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
            const st = (n.data.status ?? 'idle') as NodeStatus;
            return (
              <div key={n.id} className="sm-jobboard__row">
                <span style={{ color: statusColor[st] }}>
                  {statusIcon[st]}
                </span>
                <span className="sm-jobboard__rowlabel" title={n.data.label}>
                  {n.data.label || n.data.typeId}
                </span>
                {n.data.durationMs != null && st !== 'running' && (
                  <span className="sm-jobboard__dur">
                    {(n.data.durationMs / 1000).toFixed(1)}s
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
