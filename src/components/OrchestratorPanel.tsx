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
import OrchestratorPanelDetailView from './OrchestratorPanelDetailView';
import OrchestratorPanelListView from './OrchestratorPanelListView';
import {
  useOrchestratorPanelActions,
  type OrchestratorPanelActionCallbacks,
} from './useOrchestratorPanelActions';

export default function OrchestratorPanel({
  embedded = false,
  onRecoverWorkerRun,
  onCleanupWorkerRun,
}: { embedded?: boolean } & OrchestratorPanelActionCallbacks) {
  const {
    t,
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
    goal,
    agentId,
    readonly,
    orchestrations,
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
    onGoalChange,
    onAgentChange,
    onReadonlyChange,
    onGenerate,
    onSelect,
  } = useOrchestratorPanelActions({ onRecoverWorkerRun, onCleanupWorkerRun });

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected ? (
        <OrchestratorPanelDetailView
          selected={selected}
          allAgents={allAgents}
          workflows={workflows}
          workflowsList={workflowsList}
          wfLabel={wfLabel}
          getEffectiveStageWfId={getEffectiveStageWfId}
          selectedWorkerRuns={selectedWorkerRuns}
          taskGraphDAG={taskGraphDAG}
          taskGraphSelection={taskGraphSelection}
          selectedTaskId={selectedTaskId}
          error={error}
          busy={busy}
          cancelling={cancelling}
          recoveryBusy={recoveryBusy}
          cleanupBusy={cleanupBusy}
          canRecoverWorkerRun={canRecoverWorkerRun}
          canCleanupWorkerRun={canCleanupWorkerRun}
          revisionTitle={revisionTitle}
          revisionDependsOn={revisionDependsOn}
          revisionBusy={revisionBusy}
          canRun={canRun}
          onBack={onBack}
          onBind={onBind}
          onOpenWf={onOpenWf}
          onSelectTask={onSelectTask}
          onRevisionTitleChange={onRevisionTitleChange}
          onRevisionDependsOnChange={onRevisionDependsOnChange}
          onReviseTaskGraph={onReviseTaskGraph}
          onRecover={onRecover}
          onCleanup={onCleanup}
          onPrepare={onPrepare}
          onConfirm={onConfirm}
          onRun={onRun}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      ) : (
        <OrchestratorPanelListView
          goal={goal}
          agentId={agentId}
          readonly={readonly}
          agents={allAgents}
          orchestrations={orchestrations}
          error={error}
          onGoalChange={onGoalChange}
          onAgentChange={onAgentChange}
          onReadonlyChange={onReadonlyChange}
          onGenerate={onGenerate}
          onSelect={onSelect}
        />
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