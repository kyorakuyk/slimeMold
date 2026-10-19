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
import { taskIssueId, type TaskGraphProjectionNode } from '../projectControl/taskGraphProjection';
import { canStartLegacyOrchestration } from '../projectControl/executionBoundary';
import { reviseTaskGraphCommand } from '../projectControl/commands';
import { recordProjectEvents } from '../projectControl/eventBuffer';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';

export type OrchestratorPanelActionCallbacks = {
  onRecoverWorkerRun?: (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
    runtime?: WorkerRuntime,
  ) => Promise<void> | void;
  onCleanupWorkerRun?: (runId: string, taskId: string, action: 'approve' | 'cleanup') => Promise<void> | void;
};

export function useOrchestratorPanelActions({
  onRecoverWorkerRun,
  onCleanupWorkerRun,
}: OrchestratorPanelActionCallbacks) {
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

  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // busy covers the whole run; use a separate flag so cancellation remains available.
  const [cancelling, setCancelling] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [revisionTitle, setRevisionTitle] = useState('');
  const [revisionDependsOn, setRevisionDependsOn] = useState('');
  const [revisionDependsOnTouched, setRevisionDependsOnTouched] = useState(false);
  const [revisionBusy, setRevisionBusy] = useState(false);

  const selected = orchestrations.find((orchestration) => orchestration.id === selectedId) ?? null;
  const selectedWorkerRuns = selected
    ? workerRunViewsFor(
        workerRuns,
        workerRunRecoveries,
        selected.id,
        workerRunEvidence,
        workerRunSideEffects,
        workerCleanupProposals,
        projectControl.taskGraphs ?? [],
      )
    : [];
  const taskGraphDAG = useMemo(
    () => computeOrchestratorTaskGraph({ selected, workerRuns, projectId, taskGraphSelection, projectControl }),
    // Only issues/taskGraphs participate in this projection, matching the existing dependency granularity.
    [projectControl.issues, projectControl.taskGraphs, projectId, selected, taskGraphSelection, workerRuns],
  );
  const allAgents = [...globalAgents, ...agents];
  const workflowsList = Object.entries(workflows).map(([id, workflow]) => ({
    id,
    name: workflow?.name ?? id,
    nodeCount: (workflow?.nodes?.length ?? 0) as number,
  }));

  const wfLabel = (wfId?: string) => {
    if (!wfId) return '—';
    return workflows[wfId]?.name ?? wfId;
  };

  /** 生成草案（纯函数）并创建编排记录（readonly 经 createDraftOrchestration 固化，P0 修复）。 */
  const onGenerate = () => {
    setErr(null);
    try {
      const constraints: OrchestratorRequest['constraints'] = {};
      if (agentId) constraints.agentId = agentId;
      if (readonly) constraints.readonly = true;
      const request: OrchestratorRequest = { goal, source: 'ui', constraints };
      const orchestration = createDraftOrchestration(request, {
        agents,
        globalAgents,
        routeTable: useWorkflowStore.getState().agentRouteTable,
        defaultAgentId: useWorkflowStore.getState().defaultAgentId,
        projectId: useWorkflowStore.getState().projectId ?? undefined,
      });
      addLog('info', t('orchestrator.log.draftGenerated', {
        id: orchestration.id,
        count: orchestration.draft?.stages.length ?? 0,
      }));
      setSelectedId(orchestration.id);
      setGoal('');
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 绑定/配置某阶段工作流（awaiting-confirm / ready 状态）。 */
  const onBind = (
    orchestrationId: string,
    stageId: string,
    workflowRef: { kind: 'new' } | { kind: 'existing'; wfId: string },
  ) => {
    try {
      bindStageWorkflow(orchestrationId, stageId, workflowRef);
    } catch (cause) {
      addLog('error', cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 提前固化各阶段工作流（new → 创建空白工作流，existing → 校验存在），生成可编辑真实 wfId。 */
  const onPrepare = (orchestrationId: string) => {
    setErr(null);
    try {
      const binds = prepareStageWorkflows(orchestrationId);
      const failed = binds.filter((binding) => !binding.bind.ok);
      if (failed.length > 0) {
        const failureSummary = failed
          .map((item) => `${item.stageId} (${item.bind.ok ? '' : item.bind.error})`)
          .join('; ');
        setErr(t('orchestrator.log.prepareFailed', { failed: failureSummary }));
      } else {
        addLog('info', t('orchestrator.log.prepared', { count: binds.length }));
      }
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 确认草案（显式批准）→ ready。 */
  const onConfirm = (orchestrationId: string) => {
    try {
      confirmDraft(orchestrationId, 'approved');
      addLog('info', t('orchestrator.log.confirmed'));
    } catch (cause) {
      addLog('error', cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 开始执行（仅 ready / failed → running）。 */
  const onRun = async (orchestrationId: string) => {
    if (busy) return;
    // 运行时防御（H3c 审计：执行前必须所有阶段绑定非空工作流）：
    // 即使按钮禁用状态因数据同步/旧界面误判，这里也阻断空图执行。
    const state = useWorkflowStore.getState();
    const orchestration = state.orchestrations.find((item) => item.id === orchestrationId);
    if (!orchestration) return;
    const legacyDecision = canStartLegacyOrchestration(orchestrationId, state.workerRuns);
    if (!legacyDecision.allowed) {
      const message = legacyDecision.reason ?? t('orchestrator.hint.workerRunOwnsExecution');
      setErr(message);
      addLog('warn', message);
      return;
    }
    if (orchestration.readonly) {
      setErr(t('orchestrator.hint.readonly'));
      return;
    }
    if (!stagesReadyToRun(orchestration, state.workflows)) {
      const message = t('orchestrator.hint.notReady');
      setErr(message);
      addLog('warn', message);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await runOrchestration(orchestrationId);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  };

  /** 取消（先 stopWorkflow 当前阶段，再落 cancelled；点击后防重入）。 */
  const onCancel = (orchestrationId: string) => {
    if (cancelling) return;
    setCancelling(true);
    try {
      cancelOrchestrationRun(orchestrationId);
      addLog('info', t('orchestrator.log.cancelRequested'));
    } catch (cause) {
      setCancelling(false);
      addLog('error', cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 删除编排记录：草案直接废弃；终态历史删除需确认（均不触碰用户工作流）。 */
  const onRemove = async (orchestrationId: string, status: string) => {
    const isTerminal = status === 'done' || status === 'cancelled' || status === 'failed';
    if (isTerminal && !(await confirmDialog(t('orchestrator.deleteConfirm')))) return;
    try {
      if (removeOrchestration(orchestrationId)) {
        addLog('info', isTerminal ? t('orchestrator.log.historyDeleted') : t('orchestrator.log.draftDiscarded'));
        if (selectedId === orchestrationId) setSelectedId(null);
      }
    } catch (cause) {
      addLog('error', cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 打开阶段工作流到主画布编辑。 */
  const onOpenWf = (wfId: string) => {
    const state = useWorkflowStore.getState();
    if (state.workflows[wfId]) {
      state.switchWorkflow(wfId);
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
      } catch (cause) {
        setErr(cause instanceof Error ? cause.message : String(cause));
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
      } catch (cause) {
        setErr(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setCleanupBusy(false);
      }
    })();
  };

  const onSelectTask = (node: TaskGraphProjectionNode) => {
    if (!projectId) return;
    setTaskGraphSelection({
      projectId,
      taskGraphId: taskGraphDAG.projection!.graphId,
      taskId: node.taskId,
      issueId: node.issueId,
    });
  };

  const onRevisionDependsOnChange = (value: string) => {
    setRevisionDependsOn(value);
    setRevisionDependsOnTouched(true);
  };

  /** 对当前选中的任务提交新 TaskGraph revision，不就地改写 source graph。
   * 仅接受匹配的 graph/task/session 与显式标题或依赖编辑；沿既有事件和保存路径写回（ADR-SM-013）。
   */
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
      const state = useWorkflowStore.getState();
      state.setProjectControl(next.snapshot);
      if (state.projectPath) await state.saveProject();
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

  return {
    t,
    selected,
    allAgents,
    workflows,
    workflowsList,
    wfLabel,
    getEffectiveStageWfId: (stageId: string) => selected ? effectiveStageWfId(selected, stageId) : undefined,
    selectedWorkerRuns,
    taskGraphDAG,
    taskGraphSelection,
    selectedTaskId:
      taskGraphDAG.projection && taskGraphSelection?.taskGraphId === taskGraphDAG.projection.graphId
        ? taskGraphSelection.taskId
        : undefined,
    error: err,
    goal,
    agentId,
    readonly,
    orchestrations,
    busy,
    cancelling,
    recoveryBusy,
    cleanupBusy,
    canRecoverWorkerRun: Boolean(onRecoverWorkerRun),
    canCleanupWorkerRun: Boolean(onCleanupWorkerRun),
    revisionTitle,
    revisionDependsOn,
    revisionBusy,
    canRun: selected ? stagesReadyToRun(selected, workflows) : false,
    onBack: () => setSelectedId(null),
    onBind,
    onOpenWf,
    onSelectTask,
    onRevisionTitleChange: setRevisionTitle,
    onRevisionDependsOnChange,
    onReviseTaskGraph,
    onRecover,
    onCleanup,
    onPrepare,
    onConfirm,
    onRun,
    onCancel,
    onRemove,
    onGoalChange: setGoal,
    onAgentChange: setAgentId,
    onReadonlyChange: setReadonly,
    onGenerate,
    onSelect: setSelectedId,
  };
}
