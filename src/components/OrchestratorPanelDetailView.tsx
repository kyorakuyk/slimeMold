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
import OrchestratorPanelTaskGraphSection from './OrchestratorPanelTaskGraphSection';
import OrchestratorPanelWorkerRunsView from './OrchestratorPanelWorkerRunsView';
import { BINDABLE_STATUSES, logStatusCls, roleLabel, statusCls } from './OrchestratorPanelViewConfig';

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

        <OrchestratorPanelTaskGraphSection
          projection={taskGraphDAG.projection}
          error={taskGraphDAG.error}
          selection={taskGraphSelection}
          selectedTaskId={selectedTaskId}
          revisionTitle={revisionTitle}
          revisionDependsOn={revisionDependsOn}
          revisionBusy={revisionBusy}
          onSelectTask={onSelectTask}
          onRevisionTitleChange={onRevisionTitleChange}
          onRevisionDependsOnChange={onRevisionDependsOnChange}
          onReviseTaskGraph={onReviseTaskGraph}
        />

        {/* 草稿阶段间 DAG 边提示 */}
        {selected.draft && selected.draft.edges.length > 0 && (
          <div className="rounded border border-dashed border-line px-2.5 py-1.5 text-[10.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {selected.draft.edges.map((edge) => `${edge.from} → ${edge.to}（${edge.artifactKind}）`).join('  ·  ')}
          </div>
        )}

        <OrchestratorPanelWorkerRunsView
          runs={selectedWorkerRuns}
          canRecover={canRecoverWorkerRun}
          canCleanup={canCleanupWorkerRun}
          recoveryBusy={recoveryBusy}
          cleanupBusy={cleanupBusy}
          onRecover={onRecover}
          onCleanup={onCleanup}
        />
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
