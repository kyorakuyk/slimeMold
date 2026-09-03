/**
 * H4 GUI 开发会话面板（Phase 1）：展示 DevSession 状态（worktree / 证据 / 验收 / 审批），
 * 并提供 approveCleanup（正常确认门）与 forceCleanup（高风险，必须填 reason）的 GUI 入口。
 *
 * 安全边界：
 * - 仅 Tauri + 已初始化 DevSession 时渲染内容；否则提示不可用；
 * - approveCleanup：确认后调 session.approveCleanup（绑定验收+签名+基线），再 confirmAndCleanup
 *   （宿主原子确认门——内部二次校验验收三元组/签名/基线，清理成功才消费审批）；
 * - forceCleanup：必须填写 reason，经宿主 forceCleanup（要求宿主持久化，无则拒绝；
 *   审计落盘失败也拒绝清理）；UI 二次确认。
 */
import { useCallback, useEffect, useState } from 'react';
import { GitBranch, FileText, ShieldCheck, ShieldAlert, Trash2, Check } from 'lucide-react';
import { getDevSession } from '../dev/session';
import { isTauri, confirmDialog, alertDialog } from '../platform/env';
import { useWorkflowStore } from '../store/workflowStore';
import { getDevGuiStatus } from '../dev/gui';
import type { WorktreeInfo } from '../dev/worktree';
import type { AcceptanceRecord } from '../dev/session';
import { pathComparisonKey } from '../dev/path-utils';

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
    acceptances: [...s.acceptanceStore.values()],
    approvalPaths: [...s.approvedCleanups.keys()],
    hasPersistence: s.collector.hasPersistence(),
  };
}

export function DevSessionPanel() {
  const [snap, setSnap] = useState<SessionSnapshot>(snapshot);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
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

  const approve = useCallback(async (wt: WorktreeInfo) => {
    const s = getDevSession();
    if (!s) return;
    // 正常确认门要求绑定「本 worktree 最新通过验收」：找不到 → 拒绝审批（fail-closed）
    const passed = [...s.acceptanceStore.values()]
      .filter((a) => a.passed && pathComparisonKey(a.worktreePath) === pathComparisonKey(wt.path))
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!passed) {
      await alertDialog(`worktree「${wt.path}」没有通过验收记录——拒绝批准清理（保留供审查）。`);
      return;
    }
    const ok = await confirmDialog(
      `批准清理 worktree「${wt.path}」？\n将绑定验收 ${passed.acceptanceId} + 状态签名 + 基线一致，全部通过才会删除。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const sig = await s.computeWorktreeSignature(wt.path);
      s.approveCleanup(wt.path, {
        acceptanceId: passed.acceptanceId,
        orchestrationId: passed.orchestrationId,
        stageId: passed.stageId,
        stateSignature: sig,
        baseRevision: wt.baseRevision,
      });
      const cleaned = await s.confirmAndCleanup(wt.path);
      if (cleaned) await alertDialog(`已清理 worktree：${wt.path}`);
      else await alertDialog(`清理被拒绝（验收/签名/基线任一不满足）：${wt.path}`);
    } finally {
      setBusy(false);
      setSnap(snapshot());
    }
  }, []);

  const force = useCallback(async (wt: WorktreeInfo) => {
    const s = getDevSession();
    if (!s) return;
    if (!s.collector.hasPersistence()) {
      await alertDialog('强制清理需要宿主持久化（EvidenceStore）——当前会话无持久化，拒绝执行。');
      return;
    }
    const r = reason.trim();
    if (!r) {
      await alertDialog('强制清理必须填写 reason（审计要求）。');
      return;
    }
    const ok = await confirmDialog(
      `⚠ 强制清理会丢弃 worktree「${wt.path}」所有未提交改动！\nreason：${r}\n审计将落盘。确认执行？`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const cleaned = await s.forceCleanup(wt.path, r);
      if (cleaned) {
        setReason('');
        await alertDialog(`已强制清理 worktree：${wt.path}`);
      } else {
        await alertDialog(`强制清理失败（审计落盘失败或已被清理）：${wt.path}`);
      }
    } catch (e) {
      await alertDialog(`强制清理被拒绝：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setSnap(snapshot());
    }
  }, [reason]);

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
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-green-500/15"
                    style={{ color: 'var(--sm-ok)', border: '1px solid var(--sm-line)' }}
                    disabled={busy}
                    onClick={() => approve(wt)}
                  >
                    <Check size={11} /> 批准并清理
                  </button>
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-red-500/15"
                    style={{ color: 'var(--sm-err)', border: '1px solid var(--sm-line)' }}
                    disabled={busy}
                    onClick={() => force(wt)}
                  >
                    <Trash2 size={11} /> 强制清理
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
          <ShieldAlert size={12} /> 强制清理 reason（审计必填）
        </div>
        <textarea
          className="w-full rounded border p-1.5 text-[11px] outline-none"
          style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-soft)', color: 'var(--sm-ink)' }}
          rows={2}
          placeholder="例：测试工作区验收通过，人工确认丢弃临时改动"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
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
