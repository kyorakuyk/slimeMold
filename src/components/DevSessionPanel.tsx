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
import { useT } from '../i18n/useT';


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
  const t = useT('panels');
  const [snap, setSnap] = useState<SessionSnapshot>(snapshot);

  // 画布节点状态变化时刷新面板（dev.* 节点执行后 worktree/验收会变）
  const nodeTick = useWorkflowStore((s) => s.nodes.map((n) => `${n.id}:${n.data.status}`).join('|'));
  useEffect(() => {
    setSnap(snapshot());
  }, [nodeTick]);

  const hasSession = !!getDevSession();
  const isReady = isTauri && hasSession;

  const guiStatus = getDevGuiStatus();
  if (isTauri && guiStatus === 'unavailable') {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--sm-ink-soft)' }}>
        {t('devSession.nonGitProject')}
      </div>
    );
  }
  if (isTauri && guiStatus === 'error') {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--sm-err)' }}>
        {t('devSession.initializationFailed')} {t('devSession.retryHint')}
      </div>
    );
  }


  if (!isReady) {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
        {!isTauri
          ? t('devSession.desktopOnly')
          : t('devSession.notInitialized')}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2" style={{ color: 'var(--sm-ink-soft)' }}>
        <ShieldCheck size={13} />
        <span>{t('devSession.header')}</span>
        <span
          className="ml-auto rounded px-1.5 py-0.5"
          style={{
            color: snap.hasPersistence ? 'var(--sm-ok)' : 'var(--sm-err)',
            background: 'var(--sm-bg-soft)',
          }}
        >
          {snap.hasPersistence ? t('devSession.persistenceBound') : t('devSession.persistenceUnavailable')}
        </span>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
          <GitBranch size={12} /> {t('devSession.worktrees', { count: snap.worktrees.length })}
        </div>
        {snap.worktrees.length === 0 ? (
          <p style={{ color: 'var(--sm-ink-faint)' }}>{t('devSession.noWorktrees')}</p>
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
                  <span title={t('devSession.baseRevision')}>{wt.baseRevision.slice(0, 8)}</span>
                  {snap.approvalPaths.includes(wt.path.replace(/\\/g, '/').replace(/\/+$/, '')) && (
                    <span style={{ color: 'var(--sm-ok)' }}>{t('devSession.approved')}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>


      <div>
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
          <FileText size={12} /> {t('devSession.acceptances', { count: snap.acceptances.length })}
        </div>
        {snap.acceptances.length === 0 ? (
          <p style={{ color: 'var(--sm-ink-faint)' }}>{t('devSession.noAcceptances')}</p>
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
