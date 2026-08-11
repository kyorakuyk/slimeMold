/**
 * H3c 编排面板（Orchestrator Panel）——H3 最小闭环 UI。
 *
 * 闭环：目标输入 → 草案预览（DAG+agent）→ 为每阶段绑定/配置工作流 → 显式确认 → 执行 → 进度展示。
 *
 * 安全红线（与 docs/H3_ORCHESTRATOR_DESIGN.md §6 一致）：
 * - 生成草案是纯函数（generateDraft），不落盘、不改用户工作流；
 * - 确认门：confirmDraft 需显式批准，只置 ready（确认 ≠ 执行）；
 * - 执行：runOrchestration 仅接受 ready → running；运行前可先「固化工作流」把 new 阶段
 *   创建为真实空白工作流（activate:false）并打开编辑；
 * - 废弃只删除编排记录，不触碰用户工作流；运行中须先取消。
 */
import { useState } from 'react';
import {
  ChevronLeft,
  Target,
  Play,
  CheckCircle2,
  XCircle,
  Trash2,
  FolderOpen,
  RotateCcw,
  Workflow,
  AlertCircle,
  Plus,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';
import {
  bindStageWorkflow,
  confirmDraft,
  createDraftOrchestration,
  discardDraft,
} from '../orchestrator/confirm';
import {
  cancelOrchestrationRun,
  effectiveStageWfId,
  prepareStageWorkflows,
  runOrchestration,
  stagesReadyToRun,
} from '../orchestrator/run';
import type { OrchestratorRequest } from '../orchestrator/types';
import type { Orchestration, OrchestrationStatus, StageLog } from '../types';

/** 编排整体状态徽标配色 */
const statusCls: Record<string, string> = {
  draft: 'text-ink-faint',
  'awaiting-confirm': 'text-warn',
  ready: 'text-accent',
  running: 'text-accent',
  paused: 'text-warn',
  done: 'text-ok',
  cancelled: 'text-ink-faint',
  failed: 'text-err',
};

/** 阶段日志状态徽标配色 */
const logStatusCls: Record<string, string> = {
  pending: 'text-ink-faint',
  running: 'text-accent',
  success: 'text-ok',
  failed: 'text-err',
  skipped: 'text-ink-faint',
  cancelled: 'text-warn',
};

/** 阶段职能角色徽标 */
const roleLabel: Record<string, string> = {
  builder: 'builder',
  constructor: 'constructor',
  ops: 'ops',
};

/** 可绑定/配置的工作流状态：awaiting-confirm（确认前）与 ready（确认后执行前） */
const BINDABLE_STATUSES: ReadonlySet<OrchestrationStatus> = new Set(['awaiting-confirm', 'ready']);

export default function OrchestratorPanel({ embedded = false }: { embedded?: boolean }) {
  const t = useT('panels');
  const orchestrations = useWorkflowStore((s) => s.orchestrations);
  const workflows = useWorkflowStore((s) => s.workflows);
  const agents = useWorkflowStore((s) => s.agents);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const addLog = useWorkflowStore((s) => s.addLog);

  // 目标输入与约束
  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 当前查看的编排 id（null=列表视图）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 执行中（防重复点击执行）
  const [busy, setBusy] = useState(false);
  // 取消中（防重复点击取消；注意不能用 busy——busy 在整个 runOrchestration 阻塞期都 true，
  // 用它禁用取消按钮会导致运行期无法取消）
  const [cancelling, setCancelling] = useState(false);

  const selected = orchestrations.find((o) => o.id === selectedId) ?? null;
  const allAgents = [...globalAgents, ...agents];
  const workflowsList = Object.entries(workflows).map(([id, w]) => ({
    id,
    name: w?.name ?? id,
    nodeCount: (w?.nodes?.length ?? 0) as number,
  }));

  const agentName = (id?: string) =>
    allAgents.find((a) => a.id === id)?.name ?? id ?? '—';
  const wfLabel = (wfId?: string) => {
    if (!wfId) return '—';
    return workflows[wfId]?.name ?? wfId;
  };
  const stageLogOf = (orch: Orchestration, stageId: string): StageLog | undefined =>
    orch.stageLogs.find((l) => l.stageId === stageId);

  /** 生成草案（纯函数）并创建编排记录（readonly 经 createDraftOrchestration 固化，P0 修复） */
  const onGenerate = () => {
    setErr(null);
    try {
      const constraints: OrchestratorRequest['constraints'] = {};
      if (agentId) constraints.agentId = agentId;
      if (readonly) constraints.readonly = true;
      const request: OrchestratorRequest = { goal, source: 'ui', constraints };
      const orch = createDraftOrchestration(request, {
        agents,
        globalAgents,
        routeTable: useWorkflowStore.getState().agentRouteTable,
        defaultAgentId: useWorkflowStore.getState().defaultAgentId,
        projectId: useWorkflowStore.getState().projectId ?? undefined,
      });
      addLog(
        'info',
        `编排草案已生成（${orch.id}），共 ${orch.draft?.stages.length ?? 0} 个阶段，请绑定工作流并确认`,
      );
      setSelectedId(orch.id);
      setGoal('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 绑定/配置某阶段工作流（awaiting-confirm / ready 状态） */
  const onBind = (
    orchId: string,
    stageId: string,
    wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string },
  ) => {
    try {
      bindStageWorkflow(orchId, stageId, wfRef);
    } catch (e) {
      addLog('error', e instanceof Error ? e.message : String(e));
    }
  };

  /** 提前固化各阶段工作流（new → 创建空白工作流，existing → 校验存在），生成可编辑真实 wfId */
  const onPrepare = (orchId: string) => {
    setErr(null);
    try {
      const binds = prepareStageWorkflows(orchId);
      const failed = binds.filter((b) => !b.bind.ok);
      if (failed.length > 0) {
        setErr(
          `固化失败：${failed.map((f) => `${f.stageId}（${f.bind.ok ? '' : f.bind.error}）`).join('；')}`,
        );
      } else {
        addLog('info', `已固化 ${binds.length} 个阶段的工作流绑定，可打开编辑或开始执行`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 确认草案（显式批准）→ ready */
  const onConfirm = (orchId: string) => {
    try {
      confirmDraft(orchId, 'approved');
      addLog('info', '编排草案已确认（待执行）——可先固化/编辑阶段工作流，再开始执行');
    } catch (e) {
      addLog('error', e instanceof Error ? e.message : String(e));
    }
  };

  /** 开始执行（仅 ready / failed → running） */
  const onRun = async (orchId: string) => {
    if (busy) return;
    // 运行时防御（H3c 审计：执行前必须所有阶段绑定非空工作流）：
    // 即使按钮禁用状态因数据同步/旧界面误判，这里也阻断空图执行
    const st = useWorkflowStore.getState();
    const orch = st.orchestrations.find((o) => o.id === orchId);
    if (!orch) return;
    if (orch.readonly) {
      setErr(t('orchestrator.hint.readonly'));
      return;
    }
    if (!stagesReadyToRun(orch, st.workflows)) {
      const msg = t('orchestrator.hint.notReady');
      setErr(msg);
      addLog('warn', msg);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await runOrchestration(orchId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  };

  /** 取消（先 stopWorkflow 当前阶段，再落 cancelled；点击后防重入） */
  const onCancel = (orchId: string) => {
    if (cancelling) return;
    setCancelling(true);
    try {
      cancelOrchestrationRun(orchId);
      addLog('info', '已请求取消编排，正在停止当前阶段…');
    } catch (e) {
      setCancelling(false);
      addLog('error', e instanceof Error ? e.message : String(e));
    }
  };

  /** 废弃（仅未执行的草案可删；不触碰用户工作流） */
  const onDiscard = (orchId: string) => {
    try {
      if (discardDraft(orchId)) {
        addLog('info', '编排草案已废弃');
        if (selectedId === orchId) setSelectedId(null);
      }
    } catch (e) {
      addLog('error', e instanceof Error ? e.message : String(e));
    }
  };

  /** 打开阶段工作流到主画布编辑 */
  const onOpenWf = (wfId: string) => {
    const st = useWorkflowStore.getState();
    if (st.workflows[wfId]) {
      st.switchWorkflow(wfId);
      addLog('info', `已切换到工作流「${wfLabel(wfId)}」，可编辑后回到编排面板执行`);
    } else {
      addLog('warn', `工作流不存在：${wfId}（请先固化工作流）`);
    }
  };

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      {!selected ? (
        /* ---------- 列表视图：目标输入 + 编排列表 ---------- */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
            <label className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
              <Target size={13} /> {t('orchestrator.goalLabel')}
            </label>
            <textarea
              className="h-16 w-full resize-none rounded border border-line bg-transparent px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
              style={{ color: 'var(--sm-ink)' }}
              placeholder={t('orchestrator.goalPlaceholder')}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <select
                className="max-w-[130px] rounded border border-line bg-transparent px-1.5 py-1 outline-none"
                style={{ color: 'var(--sm-ink-soft)' }}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                title={t('orchestrator.agent')}
              >
                <option value="">{t('orchestrator.agentAuto')}</option>
                {allAgents.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[var(--sm-bg)]">
                    {a.name}
                  </option>
                ))}
              </select>
              <label className="flex cursor-pointer items-center gap-1" title={t('orchestrator.readonlyHint')}>
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={readonly}
                  onChange={(e) => setReadonly(e.target.checked)}
                />
                <span className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                  {t('orchestrator.readonly')}
                </span>
              </label>
            </div>
            <button
              className="sm-btn w-full justify-center hover:border-accent hover:text-accent"
              onClick={onGenerate}
              disabled={!goal.trim()}
            >
              <Plus size={13} /> {t('orchestrator.generate')}
            </button>
            {err && (
              <p className="flex items-start gap-1 break-all text-[11px] leading-relaxed text-err">
                <AlertCircle size={13} className="mt-0.5 shrink-0" /> {err}
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {orchestrations.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
                <Workflow size={22} className="opacity-40" />
                <p className="text-[12.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                  {t('orchestrator.empty')}
                </p>
                <p className="max-w-64 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
                  {t('orchestrator.emptyHint')}
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {orchestrations.map((o) => (
                  <li key={o.id}>
                    <button
                      className="w-full rounded border border-line px-2.5 py-2 text-left transition-colors hover:border-accent/50"
                      onClick={() => setSelectedId(o.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[11.5px] font-medium ${statusCls[o.status]}`}>
                          {t(`orchestrator.status.${o.status}`)}
                        </span>
                        <span className="shrink-0 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                          {o.draft?.stages.length ?? 0} 阶段
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 break-all text-[12px]" style={{ color: 'var(--sm-ink)' }}>
                        {o.goal}
                      </div>
                      <div className="mt-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {new Date(o.createdAt).toLocaleString()}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        /* ---------- 详情视图：草案预览 + 绑定/配置 + 确认/执行 + 进度 ---------- */
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 头部：返回 + 状态 + 目标 */}
          <div className="shrink-0 border-b border-line px-3 py-2">
            <div className="flex items-center gap-1.5">
              <button
                className="sm-btn border-transparent px-1.5"
                onClick={() => setSelectedId(null)}
                title={t('orchestrator.back')}
              >
                <ChevronLeft size={14} />
              </button>
              <span className={`text-[11.5px] font-semibold ${statusCls[selected.status]}`}>
                {t(`orchestrator.status.${selected.status}`)}
              </span>
              {selected.readonly && (
                <span className="rounded bg-paper px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                  {t('orchestrator.readonly')}
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-3 break-all text-[12.5px] leading-snug" style={{ color: 'var(--sm-ink)' }}>
              {selected.goal}
            </p>
          </div>

          {/* 阶段列表：每阶段绑定 + 阶段日志 */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
            {selected.draft?.stages.map((stage, idx) => {
              const log = stageLogOf(selected, stage.id);
              // 有效绑定：已固化 stageWfIds 优先；复用已有工作流时取 wfRef（即使未固化也可打开编辑）
              const boundWfId = effectiveStageWfId(selected, stage.id);
              const wfNodeCount = boundWfId ? workflows[boundWfId]?.nodes?.length : undefined;
              const bindable = BINDABLE_STATUSES.has(selected.status);
              return (
                <div key={stage.id} className="rounded border border-line px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]"
                        style={{ background: 'var(--sm-accent)', color: 'var(--sm-bg)' }}
                      >
                        {idx + 1}
                      </span>
                      <span className="truncate text-[12px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                        {stage.label}
                      </span>
                      <span className="shrink-0 rounded bg-paper px-1 py-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {t(`orchestrator.stage.role.${roleLabel[stage.role]}`)}
                      </span>
                      <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {agentName(stage.agentId)}
                      </span>
                    </div>
                    {log && (
                      <span className={`shrink-0 text-[10.5px] font-medium ${logStatusCls[log.status]}`}>
                        {t(`orchestrator.stageLog.${log.status}`)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 break-all text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-soft)' }}>
                    {stage.goal}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                    {stage.artifactIn && stage.artifactIn.length > 0 && (
                      <span>← {stage.artifactIn.join(', ')}</span>
                    )}
                    {stage.artifactOut && stage.artifactOut.length > 0 && (
                      <span>→ {stage.artifactOut.join(', ')}</span>
                    )}
                  </div>

                  {/* 绑定/配置工作流 */}
                  {bindable ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select
                        className="rounded border border-line bg-transparent px-1.5 py-0.5 text-[11px] outline-none"
                        style={{ color: 'var(--sm-ink-soft)' }}
                        value={stage.wfRef.kind}
                        onChange={(e) =>
                          onBind(
                            selected.id,
                            stage.id,
                            e.target.value === 'new'
                              ? { kind: 'new' }
                              : { kind: 'existing', wfId: workflowsList[0]?.id ?? '' },
                          )
                        }
                      >
                        <option value="new">{t('orchestrator.stage.bindNew')}</option>
                        <option value="existing">{t('orchestrator.stage.bindExisting')}</option>
                      </select>
                      {stage.wfRef.kind === 'existing' && (
                        <select
                          className="max-w-[150px] rounded border border-line bg-transparent px-1.5 py-0.5 text-[11px] outline-none"
                          style={{ color: 'var(--sm-ink-soft)' }}
                          value={stage.wfRef.wfId}
                          onChange={(e) => onBind(selected.id, stage.id, { kind: 'existing', wfId: e.target.value })}
                        >
                          {workflowsList.length === 0 && <option value="">—</option>}
                          {workflowsList.map((w) => (
                            <option key={w.id} value={w.id} className="bg-[var(--sm-bg)]">
                              {w.name}（{w.nodeCount}）
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {t('orchestrator.bindLocked')}
                    </div>
                  )}

                  {/* 已固化 wfId + 打开编辑 */}
                  {boundWfId && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[10.5px]" style={{ color: 'var(--sm-ink-soft)' }}>
                        {t('orchestrator.stage.boundWf')}: {wfLabel(boundWfId)}
                      </span>
                      {wfNodeCount != null && (
                        <span className="text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                          {wfNodeCount > 0
                            ? t('orchestrator.stage.nodeCount', { count: wfNodeCount })
                            : t('orchestrator.stage.emptyWf')}
                        </span>
                      )}
                      <button
                        className="flex items-center gap-0.5 rounded border border-line px-1.5 py-0.5 text-[10.5px] transition-colors hover:border-accent hover:text-accent"
                        style={{ color: 'var(--sm-ink-soft)' }}
                        onClick={() => onOpenWf(boundWfId)}
                      >
                        <FolderOpen size={11} /> {t('orchestrator.stage.open')}
                      </button>
                    </div>
                  )}

                  {/* 阶段日志详情 */}
                  {log?.error && (
                    <p className="mt-1.5 break-all text-[10.5px] leading-relaxed text-err">{log.error}</p>
                  )}
                  {log && (log.runId != null || log.startedAt || log.finishedAt) && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {log.wfId && <span>wf: {wfLabel(log.wfId)}</span>}
                      {log.runId != null && <span>run #{log.runId}</span>}
                      {log.startedAt && <span>{new Date(log.startedAt).toLocaleTimeString()}</span>}
                      {log.finishedAt && <span>→ {new Date(log.finishedAt).toLocaleTimeString()}</span>}
                    </div>
                  )}
                </div>
              );
            })}

            {/* 草稿阶段间 DAG 边提示 */}
            {selected.draft && selected.draft.edges.length > 0 && (
              <div className="rounded border border-dashed border-line px-2.5 py-1.5 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                {selected.draft.edges.map((e) => `${e.from} → ${e.to}（${e.artifactKind}）`).join('  ·  ')}
              </div>
            )}
          </div>

          {/* 操作栏 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
            {BINDABLE_STATUSES.has(selected.status) && (
              <>
                <button
                  className="sm-btn hover:border-accent hover:text-accent"
                  onClick={() => onPrepare(selected.id)}
                  title={t('orchestrator.prepareHint')}
                  disabled={busy}
                >
                  <RotateCcw size={13} /> {t('orchestrator.prepare')}
                </button>
                {selected.status === 'awaiting-confirm' && (
                  <button
                    className="sm-btn hover:border-accent hover:text-accent"
                    onClick={() => onConfirm(selected.id)}
                    disabled={busy}
                  >
                    <CheckCircle2 size={13} /> {t('orchestrator.confirm')}
                  </button>
                )}
              </>
            )}
            {(selected.status === 'ready' || selected.status === 'failed') &&
              (() => {
                // H3c：failed 可重试（failed → running 迁移表合法，复用已固化 stageWfIds）
                // 审计建议：执行前检查所有阶段已绑定非空工作流，未就绪禁用并提示
                const runnable = stagesReadyToRun(selected, workflows);
                const isRetry = selected.status === 'failed';
                return (
                  <button
                    className="sm-btn justify-center hover:border-accent hover:text-accent"
                    onClick={() => onRun(selected.id)}
                    disabled={busy || !!selected.readonly || !runnable}
                    title={
                      selected.readonly
                        ? t('orchestrator.hint.readonly')
                        : runnable
                          ? t('orchestrator.hint.ready')
                          : t('orchestrator.hint.notReady')
                    }
                  >
                    <Play size={13} /> {busy ? t('orchestrator.running') : isRetry ? t('orchestrator.retry') : t('orchestrator.run')}
                  </button>
                );
              })()}
            {(selected.status === 'running' || selected.status === 'paused') && (
              <button
                className="sm-btn text-err hover:border-err"
                onClick={() => onCancel(selected.id)}
                disabled={cancelling}
              >
                <XCircle size={13} /> {cancelling ? t('orchestrator.cancelling') : t('orchestrator.cancel')}
              </button>
            )}
            {['draft', 'awaiting-confirm', 'ready', 'failed'].includes(selected.status) && (
              <button
                className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
                onClick={() => onDiscard(selected.id)}
                title={t('orchestrator.discardHint')}
                disabled={busy}
              >
                <Trash2 size={13} />
              </button>
            )}
            {err && (
              <span className="ml-auto min-w-0 max-w-[220px] truncate text-[10.5px] text-err" title={err}>
                {err}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (embedded) return inner;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => {}}>
      <div className="flex h-[520px] w-[620px] flex-col overflow-hidden rounded-lg border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">{t('orchestrator.title')}</h2>
        </div>
        {inner}
      </div>
    </div>
  );
}
