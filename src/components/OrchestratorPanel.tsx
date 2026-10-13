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
import { useMemo, useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import { confirmDialog } from '../platform/env';
import {
  bindStageWorkflow,
  confirmDraft,
  createDraftOrchestration,
  removeOrchestration,
} from '../orchestrator/confirm';
import { computeOrchestratorTaskGraph } from './orchestratorPanelTaskGraph';
import {
  cancelOrchestrationRun,
  effectiveStageWfId,
  prepareStageWorkflows,
  runOrchestration,
  stagesReadyToRun,
} from '../orchestrator/run';
import type { OrchestratorRequest } from '../orchestrator/types';
import { workerRunViewsFor } from '../projectControl/workerRunView';
import { taskIssueId } from '../projectControl/taskGraphProjection';
import { canStartLegacyOrchestration } from '../projectControl/executionBoundary';
import { reviseTaskGraphCommand } from '../projectControl/commands';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';
import OrchestratorPanelDetailView from './OrchestratorPanelDetailView';
import OrchestratorPanelListView from './OrchestratorPanelListView';

export default function OrchestratorPanel({
  embedded = false,
  onRecoverWorkerRun,
  onCleanupWorkerRun,
}: {
  embedded?: boolean;
  onRecoverWorkerRun?: (runId: string, decision: 'retry' | 'skip', reason: string, runtime?: WorkerRuntime) => Promise<void> | void;
  onCleanupWorkerRun?: (runId: string, taskId: string, action: 'approve' | 'cleanup') => Promise<void> | void;
}) {
  const t = useT('panels');
  const orchestrations = useWorkflowStore((s) => s.orchestrations);
  const workflows = useWorkflowStore((s) => s.workflows);
  const agents = useWorkflowStore((s) => s.agents);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const addLog = useWorkflowStore((s) => s.addLog);
  const workerRuns = useWorkflowStore((s) => s.workerRuns);
  const workerRunRecoveries = useWorkflowStore((s) => s.workerRunRecoveries ?? []);
  const workerRunEvidence = useWorkflowStore((s) => s.workerRunEvidence ?? []);
  const workerRunSideEffects = useWorkflowStore((s) => s.workerRunSideEffects ?? []);
  const workerCleanupProposals = useWorkflowStore((s) => s.workerCleanupProposals ?? []);
  const projectId = useWorkflowStore((s) => s.projectId);
  const projectControl = useWorkflowStore((s) => s.projectControl);
  const taskGraphSelection = useViewStore((s) => s.taskGraphSelection);
  const setTaskGraphSelection = useViewStore((s) => s.setTaskGraphSelection);

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
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [revisionTitle, setRevisionTitle] = useState('');
  const [revisionDependsOn, setRevisionDependsOn] = useState('');
  const [revisionDependsOnTouched, setRevisionDependsOnTouched] = useState(false);
  const [revisionBusy, setRevisionBusy] = useState(false);

  const selected = orchestrations.find((o) => o.id === selectedId) ?? null;
  const selectedWorkerRuns = selected
    ? workerRunViewsFor(workerRuns, workerRunRecoveries, selected.id, workerRunEvidence, workerRunSideEffects, workerCleanupProposals, projectControl.taskGraphs ?? [])
    : [];
  // DAG 投影（orchestratorPanelTaskGraph.computeOrchestratorTaskGraph，原 useMemo 回调）
  const taskGraphDAG = useMemo(
    () => computeOrchestratorTaskGraph({ selected, workerRuns, projectId, taskGraphSelection, projectControl }),
    // 依赖粒度与原实现一致：仅 issues / taskGraphs 两个字段参与投影
    [projectControl.issues, projectControl.taskGraphs, projectId, selected, taskGraphSelection, workerRuns],
  );
  const allAgents = [...globalAgents, ...agents];
  const workflowsList = Object.entries(workflows).map(([id, w]) => ({
    id,
    name: w?.name ?? id,
    nodeCount: (w?.nodes?.length ?? 0) as number,
  }));

  const wfLabel = (wfId?: string) => {
    if (!wfId) return '—';
    return workflows[wfId]?.name ?? wfId;
  };

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
      addLog('info', t('orchestrator.log.draftGenerated', {
        id: orch.id,
        count: orch.draft?.stages.length ?? 0,
      }));
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
        const failureSummary = failed
          .map((item) => `${item.stageId} (${item.bind.ok ? '' : item.bind.error})`)
          .join('; ');
        setErr(
          t('orchestrator.log.prepareFailed', { failed: failureSummary }),
        );
      } else {
        addLog('info', t('orchestrator.log.prepared', { count: binds.length }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 确认草案（显式批准）→ ready */
  const onConfirm = (orchId: string) => {
    try {
      confirmDraft(orchId, 'approved');
      addLog('info', t('orchestrator.log.confirmed'));
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
    const legacyDecision = canStartLegacyOrchestration(orchId, st.workerRuns);
    if (!legacyDecision.allowed) {
      const msg = legacyDecision.reason ?? t('orchestrator.hint.workerRunOwnsExecution');
      setErr(msg);
      addLog('warn', msg);
      return;
    }
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
      addLog('info', t('orchestrator.log.cancelRequested'));
    } catch (e) {
      setCancelling(false);
      addLog('error', e instanceof Error ? e.message : String(e));
    }
  };

  /** 删除编排记录：草案直接废弃；终态历史删除需确认（均不触碰用户工作流） */
  const onRemove = async (orchId: string, status: string) => {
    const isTerminal = status === 'done' || status === 'cancelled' || status === 'failed';
    // 终态历史含审计信息（StageLog/runIds），删除不可恢复——需确认（平台层对话框，Tauri 安全可用）
    if (isTerminal && !(await confirmDialog(t('orchestrator.deleteConfirm')))) return;
    try {
      if (removeOrchestration(orchId)) {
        addLog('info', isTerminal ? t('orchestrator.log.historyDeleted') : t('orchestrator.log.draftDiscarded'));
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
      addLog('info', t('orchestrator.log.workflowSwitched', { name: wfLabel(wfId) }));
    } else {
      addLog('warn', t('orchestrator.log.workflowMissing', { id: wfId }));
    }
  };

  const onRecover = (runId: string, decision: 'retry' | 'skip') => {
    const selectedRun = selectedWorkerRuns.find((run) => run.runId === runId);
    if (!onRecoverWorkerRun || recoveryBusy || !selectedRun?.recoveryActions.includes(decision)) return;
    setRecoveryBusy(true);
    // This language-neutral audit reason is persisted with the recovery decision.
    const reason = `用户在专业编排中选择 ${decision}`;
    void (async () => {
      try {
        await onRecoverWorkerRun(runId, decision, reason);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setRecoveryBusy(false);
      }
    })();
  };

  const onCleanup = (runId: string, taskId: string, action: 'approve' | 'cleanup') => {
    if (!onCleanupWorkerRun || cleanupBusy) return;
    setCleanupBusy(true);
    void (async () => {
      try {
        await onCleanupWorkerRun(runId, taskId, action);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setCleanupBusy(false);
      }
    })();
  };

  const onReviseTaskGraph = async () => {
    const projection = taskGraphDAG.projection;
    const selection = taskGraphSelection;
    if (!projectId || !projection || !selection || selection.taskGraphId !== projection.graphId) {
      setErr(t('orchestrator.taskGraph.selectTask'));
      return;
    }
    const task = projection.nodes.find((node) => node.taskId === selection.taskId);
    const session = projectControl.sessions.find((item) => item.id === projection.sessionId);
    const sourceGraph = projectControl.taskGraphs?.find((graph) => graph.id === projection.graphId);
    if (!task || !session || !sourceGraph) {
      setErr(t('orchestrator.taskGraph.revisionUnavailable'));
      return;
    }
    if (!revisionTitle.trim() && !revisionDependsOnTouched) {
      setErr(t('orchestrator.taskGraph.revisionEmpty'));
      return;
    }
    setRevisionBusy(true);
    setErr(null);
    try {
      const next = reviseTaskGraphCommand({
        snapshot: projectControl,
        sessionId: session.id,
        sourceTaskGraphId: sourceGraph.id,
        id: `${sourceGraph.id}:revision:${sourceGraph.graphVersion + 1}`,
        now: new Date().toISOString(),
        changes: [{
          taskId: task.taskId,
          ...(revisionTitle.trim() ? { title: revisionTitle.trim() } : {}),
          ...(revisionDependsOnTouched
            ? { dependsOn: revisionDependsOn.split(',').map((value) => value.trim()).filter(Boolean) }
            : {}),
        }],
      });
      recordProjectEvents(projectId, next.events);
      const store = useWorkflowStore.getState();
      store.setProjectControl(next.snapshot);
      if (store.projectPath) await store.saveProject();
      setTaskGraphSelection({
        projectId,
        taskGraphId: sourceGraph.id === next.snapshot.sessions.find((item) => item.id === session.id)?.taskGraphId
          ? sourceGraph.id
          : next.snapshot.sessions.find((item) => item.id === session.id)?.taskGraphId ?? sourceGraph.id,
        taskId: task.taskId,
        issueId: taskIssueId(next.snapshot.sessions.find((item) => item.id === session.id)?.taskGraphId ?? sourceGraph.id, task.taskId),
      });
      setRevisionTitle('');
      setRevisionDependsOn('');
      setRevisionDependsOnTouched(false);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRevisionBusy(false);
    }
  };

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected ? (
        <OrchestratorPanelDetailView
          selected={selected}
          allAgents={allAgents}
          workflows={workflows}
          workflowsList={workflowsList}
          wfLabel={wfLabel}
          getEffectiveStageWfId={(stageId) => effectiveStageWfId(selected, stageId)}
          selectedWorkerRuns={selectedWorkerRuns}
          taskGraphDAG={taskGraphDAG}
          taskGraphSelection={taskGraphSelection}
          selectedTaskId={
            taskGraphDAG.projection
              && taskGraphSelection?.taskGraphId === taskGraphDAG.projection.graphId
              ? taskGraphSelection.taskId
              : undefined
          }
          error={err}
          busy={busy}
          cancelling={cancelling}
          recoveryBusy={recoveryBusy}
          cleanupBusy={cleanupBusy}
          canRecoverWorkerRun={Boolean(onRecoverWorkerRun)}
          canCleanupWorkerRun={Boolean(onCleanupWorkerRun)}
          revisionTitle={revisionTitle}
          revisionDependsOn={revisionDependsOn}
          revisionBusy={revisionBusy}
          canRun={stagesReadyToRun(selected, workflows)}
          onBack={() => setSelectedId(null)}
          onBind={onBind}
          onOpenWf={onOpenWf}
          onSelectTask={(node) => {
            if (!projectId) return;
            setTaskGraphSelection({
              projectId,
              taskGraphId: taskGraphDAG.projection!.graphId,
              taskId: node.taskId,
              issueId: node.issueId,
            });
          }}
          onRevisionTitleChange={setRevisionTitle}
          onRevisionDependsOnChange={(value) => {
            setRevisionDependsOn(value);
            setRevisionDependsOnTouched(true);
          }}
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
          error={err}
          onGoalChange={setGoal}
          onAgentChange={setAgentId}
          onReadonlyChange={setReadonly}
          onGenerate={onGenerate}
          onSelect={setSelectedId}
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
