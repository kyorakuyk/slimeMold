import {
  CheckCircle2,
  ChevronLeft,
  FolderOpen,
  Play,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useT } from '../i18n/useT';
import type { WorkerRunView } from '../projectControl/workerRunView';
import type { TaskGraphProjection, TaskGraphProjectionNode } from '../projectControl/taskGraphProjection';
import type { TaskGraphSelection } from '../store/viewStore';
import type { AgentConfig } from '../types/agent';
import type { Orchestration, StageLog } from '../types/orchestration';
import type { WorkflowFileInMemory } from '../types/workflow';
import TaskGraphDAGView from './TaskGraphDAGView';
import { BINDABLE_STATUSES, logStatusCls, roleLabel, statusCls, workerStatusCls } from './OrchestratorPanelViewConfig';

interface WorkflowPickerOption {
  id: string;
  name: string;
  nodeCount: number;
}

interface OrchestratorPanelDetailViewProps {
  selected: Orchestration;
  allAgents: readonly AgentConfig[];
  workflows: Record<string, WorkflowFileInMemory>;
  workflowsList: readonly WorkflowPickerOption[];
  wfLabel: (wfId?: string) => string;
  getEffectiveStageWfId: (stageId: string) => string | undefined;
  selectedWorkerRuns: readonly WorkerRunView[];
  taskGraphDAG: { projection: TaskGraphProjection | null; error: string | null };
  taskGraphSelection: TaskGraphSelection | null;
  selectedTaskId?: string;
  error: string | null;
  busy: boolean;
  cancelling: boolean;
  recoveryBusy: boolean;
  cleanupBusy: boolean;
  canRecoverWorkerRun: boolean;
  canCleanupWorkerRun: boolean;
  revisionTitle: string;
  revisionDependsOn: string;
  revisionBusy: boolean;
  canRun: boolean;
  onBack: () => void;
  onBind: (
    orchId: string,
    stageId: string,
    wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string },
  ) => void;
  onOpenWf: (wfId: string) => void;
  onSelectTask: (node: TaskGraphProjectionNode) => void;
  onRevisionTitleChange: (value: string) => void;
  onRevisionDependsOnChange: (value: string) => void;
  onReviseTaskGraph: () => void | Promise<void>;
  onRecover: (runId: string, decision: 'retry' | 'skip') => void;
  onCleanup: (runId: string, taskId: string, action: 'approve' | 'cleanup') => void;
  onPrepare: (orchId: string) => void;
  onConfirm: (orchId: string) => void;
  onRun: (orchId: string) => void;
  onCancel: (orchId: string) => void;
  onRemove: (orchId: string, status: string) => void;
}

export default function OrchestratorPanelDetailView({
  selected,
  allAgents,
  workflows,
  workflowsList,
  wfLabel,
  getEffectiveStageWfId,
  selectedWorkerRuns,
  taskGraphDAG,
  taskGraphSelection,
  selectedTaskId,
  error,
  busy,
  cancelling,
  recoveryBusy,
  cleanupBusy,
  canRecoverWorkerRun,
  canCleanupWorkerRun,
  revisionTitle,
  revisionDependsOn,
  revisionBusy,
  canRun,
  onBack,
  onBind,
  onOpenWf,
  onSelectTask,
  onRevisionTitleChange,
  onRevisionDependsOnChange,
  onReviseTaskGraph,
  onRecover,
  onCleanup,
  onPrepare,
  onConfirm,
  onRun,
  onCancel,
  onRemove,
}: OrchestratorPanelDetailViewProps) {
  const t = useT('panels');
  const agentName = (id?: string) =>
    allAgents.find((agent) => agent.id === id)?.name ?? id ?? '—';
  const stageLogOf = (orch: Orchestration, stageId: string): StageLog | undefined =>
    orch.stageLogs.find((log) => log.stageId === stageId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：返回 + 状态 + 目标 */}
      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            className="sm-btn border-transparent px-1.5"
            onClick={onBack}
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
          const boundWfId = getEffectiveStageWfId(stage.id);
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
                    onChange={(event) =>
                      onBind(
                        selected.id,
                        stage.id,
                        event.target.value === 'new'
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
                      onChange={(event) => onBind(selected.id, stage.id, { kind: 'existing', wfId: event.target.value })}
                    >
                      {workflowsList.length === 0 && <option value="">—</option>}
                      {workflowsList.map((workflow) => (
                        <option key={workflow.id} value={workflow.id} className="bg-[var(--sm-bg)]">
                          {workflow.name}（{workflow.nodeCount}）
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

        {taskGraphDAG.projection && (
          <TaskGraphDAGView
            projection={taskGraphDAG.projection}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        )}
        {taskGraphDAG.projection && taskGraphDAG.projection.approval !== 'superseded' && (
          <details className="rounded border border-line px-2.5 py-2" data-testid="taskgraph-revision-editor">
            <summary className="cursor-pointer text-[11px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
              {t('orchestrator.taskGraph.revise')}
            </summary>
            <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
              <p style={{ color: 'var(--sm-ink-faint)' }}>
                {t('orchestrator.taskGraph.selectedTask')}: {taskGraphSelection?.taskId ?? t('orchestrator.taskGraph.noneSelected')}
              </p>
              <input
                className="rounded border border-line bg-transparent px-2 py-1 outline-none focus:border-accent"
                placeholder={t('orchestrator.taskGraph.titlePlaceholder')}
                value={revisionTitle}
                onChange={(event) => onRevisionTitleChange(event.target.value)}
                disabled={!taskGraphSelection || revisionBusy}
              />
              <input
                className="rounded border border-line bg-transparent px-2 py-1 outline-none focus:border-accent"
                placeholder={t('orchestrator.taskGraph.dependsOnPlaceholder')}
                value={revisionDependsOn}
                onChange={(event) => onRevisionDependsOnChange(event.target.value)}
                disabled={!taskGraphSelection || revisionBusy}
              />
              <button
                type="button"
                className="sm-btn justify-center hover:border-accent hover:text-accent"
                onClick={() => { void onReviseTaskGraph(); }}
                disabled={!taskGraphSelection || revisionBusy}
              >
                {t('orchestrator.taskGraph.applyRevision')}
              </button>
            </div>
          </details>
        )}
        {taskGraphDAG.error && (
          <div className="rounded border border-dashed border-warn px-2.5 py-1.5 text-[10.5px] text-warn" data-testid="orchestrator-taskgraph-dag-error">
            {taskGraphDAG.error}
          </div>
        )}

        {/* 草稿阶段间 DAG 边提示 */}
        {selected.draft && selected.draft.edges.length > 0 && (
          <div className="rounded border border-dashed border-line px-2.5 py-1.5 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {selected.draft.edges.map((edge) => `${edge.from} → ${edge.to}（${edge.artifactKind}）`).join('  ·  ')}
          </div>
        )}

        {selectedWorkerRuns.length > 0 && (
          <section className="rounded border border-line px-2.5 py-2" data-testid="orchestrator-worker-runs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
                {t('orchestrator.workerRuns.title')}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                {selectedWorkerRuns.length}
              </span>
            </div>
            <div className="mt-1.5 space-y-2">
              {selectedWorkerRuns.map((run) => (
                <div key={run.runId} className="rounded border border-dashed border-line px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10.5px] font-medium ${workerStatusCls[run.status] ?? 'text-ink-faint'}`}>
                      {t(`orchestrator.worker.status.${run.status}`)}
                    </span>
                    <span className="truncate font-mono text-[10px]" style={{ color: 'var(--sm-ink-faint)' }} title={run.runId}>
                      {run.runId}
                    </span>
                  </div>
                  {run.recovery && (
                    <div className="mt-1 space-y-1">
                      <p className="break-all text-[10.5px] text-warn">
                        {t('orchestrator.worker.recovery')}: {run.recovery.message}
                      </p>
                      {canRecoverWorkerRun && run.recoveryActions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {run.recoveryActions.includes('retry') && (
                            <button
                              type="button"
                              data-testid={`orchestrator-worker-retry-${run.runId}`}
                              className="rounded border border-line px-1.5 py-0.5 text-[10px] text-accent disabled:opacity-50"
                              disabled={recoveryBusy}
                              onClick={() => onRecover(run.runId, 'retry')}
                            >
                              {t('orchestrator.worker.recovery.retryAction')}
                            </button>
                          )}
                          {run.recoveryActions.includes('skip') && (
                            <button
                              type="button"
                              data-testid={`orchestrator-worker-skip-${run.runId}`}
                              className="rounded border border-line px-1.5 py-0.5 text-[10px] text-warn disabled:opacity-50"
                              disabled={recoveryBusy}
                              onClick={() => onRecover(run.runId, 'skip')}
                            >
                              {t('orchestrator.worker.recovery.skipAction')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <ul className="mt-1 space-y-1">
                    {run.tasks.map((task) => (
                      <li key={task.taskId} className="rounded bg-paper px-1.5 py-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[10.5px]" style={{ color: 'var(--sm-ink)' }} title={task.taskId}>
                            {task.taskId}
                          </span>
                          <span className={`shrink-0 text-[10px] ${workerStatusCls[task.status] ?? 'text-ink-faint'}`}>
                            {t(`orchestrator.worker.task.${task.status}`)} · a{task.attempt}
                          </span>
                        </div>
                        {task.error && (
                          <p className="mt-0.5 break-all text-[10px] text-err">{task.error}</p>
                        )}
                        {task.worktreePath && (
                          <p className="mt-0.5 truncate font-mono text-[9.5px]" style={{ color: 'var(--sm-ink-faint)' }} title={task.worktreePath}>
                            {t('orchestrator.worker.worktree')}: {task.worktreePath}
                          </p>
                        )}
                        {task.evidenceIds.length > 0 && (
                          <p className="mt-0.5 break-all font-mono text-[9.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                            {t('orchestrator.worker.evidence')}: {task.evidenceIds.join(', ')}
                          </p>
                        )}
                        {task.evidence.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 pl-2 text-[9.5px]" data-testid={`orchestrator-worker-evidence-${task.taskId}`}>
                            {task.evidence.map((record) => (
                              <li key={record.id} className="break-all" style={{ color: 'var(--sm-ink-faint)' }}>
                                <span className={record.status === 'passed' ? 'text-ok' : record.status === 'failed' ? 'text-err' : 'text-warn'}>
                                  {record.kind} · {record.status}
                                </span>
                                {' · '}{record.summary}
                                {record.command ? ` · ${record.command}` : ''}
                                {record.exitCode !== undefined ? ` · ${t('orchestrator.worker.exitCode')}: ${record.exitCode}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                        {task.sideEffects.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 pl-2 text-[9.5px]" data-testid={`orchestrator-worker-receipts-${task.taskId}`}>
                            {task.sideEffects.map((effect) => (
                              <li key={effect.idempotencyKey} className="break-all" style={{ color: 'var(--sm-ink-faint)' }}>
                                <span className={effect.status === 'receipt' ? 'text-ok' : effect.status === 'unknown' ? 'text-warn' : 'text-accent'}>
                                  {t('orchestrator.worker.receipt')}: {effect.kind} · {effect.status}
                                </span>
                                {effect.receiptId ? ` · ${effect.receiptId}` : ''}
                                {effect.unknownReason ? ` · ${effect.unknownReason}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                        {task.cleanup ? (
                          task.cleanup.status === 'ready' ? (
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px]" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                              <span className="break-all text-ok">
                                {t('orchestrator.worker.cleanup')}: {task.cleanup.approvalStatus === 'approved' ? t('orchestrator.worker.cleanup.approved') : t('orchestrator.worker.cleanup.ready')} · {task.cleanup.acceptanceId}
                              </span>
                              {canCleanupWorkerRun && (
                                <button
                                  type="button"
                                  data-testid={`orchestrator-worker-cleanup-action-${task.taskId}`}
                                  className="rounded border border-line px-1.5 py-0.5 text-[10px] text-accent disabled:opacity-50"
                                  disabled={cleanupBusy}
                                  onClick={() => {
                                    const proposal = task.cleanup;
                                    if (!proposal || proposal.status !== 'ready') return;
                                    onCleanup(
                                      proposal.runId,
                                      task.taskId,
                                      proposal.approvalStatus === 'approved' ? 'cleanup' : 'approve',
                                    );
                                  }}
                                >
                                  {task.cleanup.approvalStatus === 'approved'
                                    ? t('orchestrator.worker.cleanup.executeAction')
                                    : t('orchestrator.worker.cleanup.approveAction')}
                                </button>
                              )}
                            </div>
                          ) : task.cleanup.status === 'cleaned' ? (
                            <p className="mt-0.5 break-all text-[9.5px] text-ok" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                              {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.cleaned')} · {task.cleanup.receiptId}
                            </p>
                          ) : (
                            <p className="mt-0.5 break-all text-[9.5px] text-warn" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                              {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.blocked')}: {task.cleanup.reason}
                            </p>
                          )
                        ) : task.status === 'succeeded' ? (
                          <p className="mt-0.5 break-all text-[9.5px] text-warn" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                            {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.unavailable')}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
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
            const isRetry = selected.status === 'failed';
            const workerOwnsExecution = selectedWorkerRuns.length > 0;
            return (
              <button
                className="sm-btn justify-center hover:border-accent hover:text-accent"
                onClick={() => onRun(selected.id)}
                disabled={busy || !!selected.readonly || !canRun || workerOwnsExecution}
                title={
                  selected.readonly
                    ? t('orchestrator.hint.readonly')
                    : workerOwnsExecution
                      ? t('orchestrator.hint.workerRunOwnsExecution')
                      : canRun
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
        {selected.status !== 'running' && selected.status !== 'paused' && (
          <button
            className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
            onClick={() => onRemove(selected.id, selected.status)}
            title={t('orchestrator.deleteHint')}
            disabled={busy}
          >
            <Trash2 size={13} />
          </button>
        )}
        {error && (
          <span className="ml-auto min-w-0 max-w-[220px] truncate text-[10.5px] text-err" title={error}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
