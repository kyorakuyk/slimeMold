import { useWorkflowStore } from '../store/workflowStore';
import type { NodeStatus } from '../types';
import { CheckCircle2, XCircle, Loader2, Circle, Zap, SkipForward } from 'lucide-react';

const statusMeta: Record<NodeStatus, { label: string; icon: JSX.Element; color: string }> = {
  idle: { label: '等待', icon: <Circle size={11} />, color: '#9aa0a6' },
  running: { label: '执行中', icon: <Loader2 size={11} className="animate-spin" />, color: '#3b82f6' },
  success: { label: '完成', icon: <CheckCircle2 size={11} />, color: '#2e9e5b' },
  error: { label: '失败', icon: <XCircle size={11} />, color: '#e0524d' },
  cached: { label: '缓存', icon: <Zap size={11} />, color: '#b07cff' },
  skipped: { label: '跳过', icon: <SkipForward size={11} />, color: '#9aa0a6' },
  bypassed: { label: '旁路', icon: <SkipForward size={11} />, color: '#9aa0a6' },
  muted: { label: '静音', icon: <Circle size={11} />, color: '#9aa0a6' },
};

/**
 * 运行期调度看板（Job Board）：浮于画布右上角，展示
 * - 拓扑分层进度（第 N / 总层）
 * - 循环轮次（第 R / 总轮）
 * - 各节点 task 状态汇总（按状态分组计数）
 * 数据来自 workflowStore.runProgress 与 nodes[].data.status。
 */
export default function JobBoard() {
  const running = useWorkflowStore((s) => s.running);
  const runProgress = useWorkflowStore((s) => s.runProgress);
  const nodes = useWorkflowStore((s) => s.nodes);

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
        <span className="sm-jobboard__title">调度看板</span>
        {runProgress.totalRounds > 1 && (
          <span className="sm-jobboard__round">
            轮次 {runProgress.round}/{runProgress.totalRounds}
          </span>
        )}
      </div>

      <div className="sm-jobboard__progress">
        <div className="sm-jobboard__bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="sm-jobboard__meta">
        拓扑层 {runProgress.layer}/{runProgress.totalLayers} · 完成 {done}/{nodes.length}
      </div>

      <div className="sm-jobboard__stats">
        {(Object.keys(statusMeta) as NodeStatus[]).map((st) =>
          counts[st] > 0 ? (
            <span
              key={st}
              className="sm-jobboard__chip"
              style={{ color: statusMeta[st].color }}
              title={statusMeta[st].label}
            >
              {statusMeta[st].icon}
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
                <span style={{ color: statusMeta[st].color }}>
                  {statusMeta[st].icon}
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
