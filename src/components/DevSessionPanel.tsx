/**
 * H4 GUI 开发会话面板（Phase 1）：只读展示 DevSession 状态（worktree / 证据 / 验收 / 审批）。
 * 破坏性 Cleanup 统一从 TaskGraph-backed Worker proposal/action 入口执行。
 *
 * 安全边界：
 * - 仅 Tauri + 已初始化 DevSession 时渲染内容；否则提示不可用；
 * - 破坏性清理不从此面板发起，避免 legacy direct path 绕过 WorkerQueue lineage/fingerprint；
 * - 面板仅展示状态，用户从 Worker Task proposal/action 完成审批与 CleanupReceipt。
 */
import { useEffect, useState } from 'react';
import { GitBranch, FileText, ShieldCheck } from 'lucide-react';
import { getDevSession } from '../dev/session';
import { isTauri } from '../platform/env';
import { useWorkflowStore } from '../store/workflowStore';
import { getDevGuiStatus } from '../dev/gui';
import type { WorktreeInfo } from '../dev/worktree';
import type { AcceptanceRecord } from '../dev/session';


interface SessionSnapshot {
  worktrees: WorktreeInfo[];
  acceptances: AcceptanceRecord[];
  approvalPaths: string[];
  hasPersistence: boolean;
}

/** 从 DevSession 读取一次性快照（面板展示用；不订阅内部 Map 变化，由画布节点状态驱动刷新）。 */
function snapshot(): SessionSnapshot {
  const s = getDevSession();
  if (!s) return { worktrees: [], acceptances: [], approvalPaths: [], hasPersistence: false };
  return {
    worktrees: s.manager.list(),
    acceptances: [...s.listAcceptances()],
    approvalPaths: s.listCleanupApprovals().map((item) => item.worktreePath),
    hasPersistence: s.collector.hasPersistence(),
  };
}

export function DevSessionPanel() {
  const [snap, setSnap] = useState<SessionSnapshot>(snapshot);

  // 画布节点状态变化时刷新面板（dev.* 节点执行后 worktree/验收会变）
  const nodeTick = useWorkflowStore((s) => s.nodes.map((n) => `${n.id}:${n.data.status}`).join('|'));
  useEffect(() => {
    setSnap(snapshot());
  }, [nodeTick]);

  const hasSession = !!getDevSession();
  const isReady = isTauri && hasSession;

  // 审计 P1：宿主初始化失败 → 显式「开发能力不可用」，不静默吞异常
  if (isTauri && getDevGuiStatus() === 'unavailable') {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--sm-err)' }}>
        H4 开发能力不可用：宿主 DevSession 初始化失败（dev_init_session 未成功）。
        请重新打开项目或查看日志后重试。
      </div>
    );
  }


  if (!isReady) {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
        {!isTauri
          ? 'H4 开发会话仅桌面端（Tauri）可用。'
          : 'H4 开发会话未初始化（请先打开一个项目）。'}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2" style={{ color: 'var(--sm-ink-soft)' }}>
        <ShieldCheck size={13} />
        <span>DevSession（宿主导航）</span>
        <span
          className="ml-auto rounded px-1.5 py-0.5"
          style={{
            color: snap.hasPersistence ? 'var(--sm-ok)' : 'var(--sm-err)',
            background: 'var(--sm-bg-soft)',
          }}
        >
          {snap.hasPersistence ? 'EvidenceStore 已绑定' : '无宿主持久化'}
        </span>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
          <GitBranch size={12} /> Worktree（{snap.worktrees.length}）
        </div>
        {snap.worktrees.length === 0 ? (
          <p style={{ color: 'var(--sm-ink-faint)' }}>暂无 worktree（自举任务从 dev.worktree.create 开始）</p>
        ) : (
          <ul className="space-y-2">
            {snap.worktrees.map((wt) => (
              <li key={wt.id} className="rounded border p-2" style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-soft)' }}>
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono" title={wt.path}>{wt.path}</span>
                  <span className="ml-auto shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--sm-bg)' }}>
                    {wt.branch}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                  <span title="基线提交">{wt.baseRevision.slice(0, 8)}</span>
                  {snap.approvalPaths.includes(wt.path.replace(/\\/g, '/').replace(/\/+$/, '')) && (
                    <span style={{ color: 'var(--sm-ok)' }}>· 已批准</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>


      <div>
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
          <FileText size={12} /> 验收记录（{snap.acceptances.length}）
        </div>
        {snap.acceptances.length === 0 ? (
          <p style={{ color: 'var(--sm-ink-faint)' }}>暂无验收记录</p>
        ) : (
          <ul className="space-y-1">
            {snap.acceptances.map((a) => (
              <li key={a.acceptanceId} className="flex items-center gap-2">
                <span
                  className="rounded px-1 text-[10px]"
                  style={{
                    color: a.passed ? 'var(--sm-ok)' : 'var(--sm-err)',
                    background: 'var(--sm-bg)',
                  }}
                >
                  {a.passed ? 'PASS' : 'FAIL'}
                </span>
                <span className="font-mono" style={{ color: 'var(--sm-ink-soft)' }}>
                  {a.acceptanceId}
                </span>
                <span className="truncate" style={{ color: 'var(--sm-ink-faint)' }}>
                  {a.worktreePath}
                </span>
                {a.failedChecks.length > 0 && (
                  <span title={a.failedChecks.join('\n')} style={{ color: 'var(--sm-err)' }}>
                    ×{a.failedChecks.length}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
