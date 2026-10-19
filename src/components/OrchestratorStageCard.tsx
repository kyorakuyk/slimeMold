import { FolderOpen } from 'lucide-react';
import { useT } from '../i18n/useT';
import { formatTime } from '../i18n/dateTime';
import type { Orchestration, StageLog } from '../types/orchestration';
import { logStatusCls, roleLabel } from './OrchestratorPanelViewConfig';

export type OrchestratorStage = NonNullable<Orchestration['draft']>['stages'][number];

interface WorkflowPickerOption {
  id: string;
  name: string;
  nodeCount: number;
}

export interface OrchestratorStageCardProps {
  stage: OrchestratorStage;
  index: number;
  /** 所属编排 id（绑定回调的第一个参数） */
  parentId: string;
  log?: StageLog;
  /** 有效绑定工作流（已固化 stageWfIds 优先，其次 wfRef） */
  boundWfId?: string;
  wfNodeCount?: number;
  bindable: boolean;
  workflowsList: readonly WorkflowPickerOption[];
  wfLabel: (wfId?: string) => string;
  agentName: (id?: string) => string;
  onBind: (
    orchId: string,
    stageId: string,
    wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string },
  ) => void;
  onOpenWf: (wfId: string) => void;
}

/**
 * 阶段卡片：序号/角色/智能体、阶段日志状态、目标、产物方向、绑定下拉、已固化工作流与打开按钮、日志详情。
 * 从 OrchestratorPanelDetailView 的 stages.map 内联 JSX 抽出，DOM 与分支顺序保持原样。
 * 可绑定与已绑定分别由 `bindable`/`boundWfId` 决定；更新只经父层 callbacks（ADR-SM-005、ADR-SM-017）。
 */
export default function OrchestratorStageCard({
  stage,
  index,
  parentId,
  log,
  boundWfId,
  wfNodeCount,
  bindable,
  workflowsList,
  wfLabel,
  agentName,
  onBind,
  onOpenWf,
}: OrchestratorStageCardProps) {
  const t = useT('panels');

  return (
    <div className="rounded border border-line px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]"
            style={{ background: 'var(--sm-accent)', color: 'var(--sm-bg)' }}
          >
            {index + 1}
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
                parentId,
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
              onChange={(event) => onBind(parentId, stage.id, { kind: 'existing', wfId: event.target.value })}
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
          {log.startedAt && <span>{formatTime(log.startedAt)}</span>}
          {log.finishedAt && <span>→ {formatTime(log.finishedAt)}</span>}
        </div>
      )}
    </div>
  );
}
