import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { X, Keyboard } from 'lucide-react';
import TopBar from './components/TopBar';
import Inspector from './components/Inspector';
import StatusBar from './components/StatusBar';
import SettingsCenter from './components/SettingsCenter';
import { SideRail, SidePanel, type SidePanelKey } from './components/LeftSidebar';
import ShortcutsModal from './components/ShortcutsModal';
import ExamplesModal from './components/ExamplesModal';
import WorkflowWizard from './components/WorkflowWizard';
import WelcomeModal from './components/WelcomeModal';
import NewProjectModal from './components/NewProjectModal';
import InterventionModal from './components/InterventionModal';
import BeginnerExperience from './components/BeginnerExperience';
import WindowTitleBar from './components/WindowTitleBar';
import WorkflowEditor from './canvas/WorkflowEditor';
import { NamePrompt } from './components/NamePrompt';
import { registerBuiltins } from './nodes/builtin';
import { scanPluginsDir, scanProgramCustomNodes } from './plugins/pluginManager';
import { createProjectLifecycleController, type ProjectOperation } from './projectControl/projectLifecycleController';
import { isTauri } from './platform/env';
import { getLastSession, saveProjectFile } from './io/projectIO';
import { exportWorkflow } from './io/workflowIO';
import { useWorkflowStore } from './store/workflowStore';
import { buildProjectFile } from './store/workflowSerialize';
import { shouldRenderWelcomeModal, useViewStore } from './store/viewStore';
import { loadGlobalAgents } from './agents/globalAgents';
import { useWorkflowFileDrop } from './hooks/useWorkflowFileDrop';
import { ensureGuiDevSession, getDevGuiError } from './dev/gui';
import { startProjectSessionCommand } from './projectControl/commands';
import { recordProjectEvents, flushPendingProjectEvents } from './projectControl/eventBuffer';
import { createGuiProjectWorkerRunCoordinator } from './projectControl/workerRunCoordinator';
import { recoverWorkerRunCommand } from './projectControl/workerRecoveryCommand';
import {
  getRestoredWorkerRunForCleanup,
  installWorkerRunRuntime,
  type WorkerRunRecovery,
} from './projectControl/workerRunRuntime';
import {
  approveWorkerCleanupProposal,
  buildWorkerCleanupProposalSafely,
} from './projectControl/workerCleanup';
import { executeWorkerCleanupWithReceipt } from './projectControl/workerCleanupExecution';
import { markWorkerTaskCleaned } from './projectControl/workerCleanupCommand';
import { auditWorkerRunConsistency } from './projectControl/workerRunConsistency';
import { ensureProjectControlEventBaseline } from './projectControl/eventSourceBootstrap';
import { auditProjectControlConsistency } from './projectControl/projectControlConsistency';
import { projectWorkerRunsOntoOrchestrations, suppressInvalidWorkerRunProjection } from './projectControl/workerRunOrchestrationProjection';
import { reconcileWorkerRunsFromEvents, rehydrateWorkerRunsFromEvents } from './projectControl/workerRunRehydration';
import type { WorkerRunQueueState } from './domain/workerQueue';
import type { WorkerRunConsistencyReport } from './projectControl/workerRunConsistency';
import type { AcceptanceRecord } from './dev/session';
import type { DomainProjection, SideEffectRecord } from './domain/contracts';
import { createAttemptId, createTaskExecutionId } from './domain/execution';
import { EventStreamRepository } from './domain/eventStore';
import {
  loadWorkerEvidence,
  loadWorkerSideEffects,
  mergeWorkerEvidence,
  mergeWorkerSideEffects,
} from './projectControl/workerEvidence';

registerBuiltins();

function reconcileSuccessfulCleanupReceipts(
  runs: readonly WorkerRunQueueState[],
  effects: readonly SideEffectRecord[],
): { runs: WorkerRunQueueState[]; events: ReturnType<typeof markWorkerTaskCleaned>['events'] } {
  const nextRuns = [...runs];
  const events: ReturnType<typeof markWorkerTaskCleaned>['events'] = [];
  for (const run of runs) {
    let nextRun = run;
    for (const [taskId, task] of Object.entries(run.tasks)) {
      if (task.cleanupStatus === 'cleaned' || !task.worktreePath || task.attempt < 1) continue;
      const taskExecutionId = task.taskExecutionId ?? createTaskExecutionId(run.runId, taskId);
      const attemptId = task.currentAttemptId ?? createAttemptId(taskExecutionId, task.attempt);
      const receipt = effects.find((entry) => (
        entry.kind === 'worktree-cleanup'
        && entry.idempotencyKey === `cleanup:${attemptId}`
        && entry.status === 'receipt'
        && entry.recovery === 'skip'
        && entry.receipt?.outcome === 'succeeded'
      ));
      const stateSignature = receipt?.receipt?.outputHash;
      if (!receipt || !stateSignature) continue;
      try {
        const reconciled = markWorkerTaskCleaned({
          state: nextRun,
          taskId,
          receiptId: receipt.receipt?.receiptId ?? '',
          taskExecutionId,
          attemptId,
          stateSignature,
          receipt,
          decisionId: `cleanup-reconcile:${receipt.receipt?.receiptId ?? attemptId}`,
          now: receipt.receipt?.observedAt ?? new Date().toISOString(),
        });
        nextRun = reconciled.state;
        events.push(...reconciled.events);
      } catch {
        // A receipt that does not match the current task is not trusted for migration.
      }
    }
    const index = nextRuns.findIndex((item) => item.runId === run.runId);
    if (index >= 0) nextRuns[index] = nextRun;
  }
  return { runs: nextRuns, events };
}

function cleanupUnknownRunIds(effects: readonly SideEffectRecord[]): Set<string> {
  return new Set(
    effects
      .filter((entry) => entry.kind === 'worktree-cleanup'
        && (entry.status === 'unknown' || entry.recovery === 'needs-user')
        && !!entry.runId)
      .map((entry) => entry.runId as string),
  );
}

/** 拆分视图：左右并排显示两个不同的工作流图，右侧边栏显示焦点节点信息 */
function SplitCanvas({
  splitWfId,
  setSplitWfId,
  onNewProject,
}: {
  splitWfId: string;
  setSplitWfId: (id: string) => void;
  onNewProject?: () => void;
}) {
  const workflows = useWorkflowStore((s) => s.workflows);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const ids = Object.keys(workflows);
  // 右侧分栏默认显示「非当前激活」的第一个工作流
  const targetId =
    splitWfId && workflows[splitWfId]
      ? splitWfId
      : ids.find((id) => id !== activeWfId) ?? activeWfId;

  return (
    <div className="flex min-w-0 flex-1">
      {/* 左：当前激活工作流 */}
      <div className="min-w-0 flex-1 border-r border-sm-line">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-sm-line px-3 text-[12px] text-sm-ink-soft">
          <span className="font-semibold text-sm-ink">主工作流</span>
          <span className="truncate text-sm-ink-faint">
            {workflows[activeWfId]?.name ?? ''}
          </span>
        </div>
        <div className="h-[calc(100%-1.75rem)]">
          <WorkflowEditor onNewProject={onNewProject} />
        </div>
      </div>

      {/* 右：另一个工作流（可在下拉中切换） */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-sm-line px-3">
          <span className="shrink-0 text-[12px] font-semibold text-sm-ink">
            拆分视图
          </span>
          <select
            className="max-w-[200px] flex-1 rounded border border-sm-line bg-transparent px-1.5 py-0.5 text-[11.5px] text-sm-ink-soft outline-none"
            value={targetId}
            onChange={(e) => setSplitWfId(e.target.value)}
            title="选择右侧分栏显示的工作流"
          >
            {ids.map((id) => (
              <option key={id} value={id} className="bg-sm-bg">
                {workflows[id]?.name ?? id}
                {id === activeWfId ? '（主）' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1">
          {ids.length <= 1 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px] text-sm-ink-faint">
              项目中只有一个工作流。新建一个工作流即可在拆分视图中并排查看/编辑不同工作流。
            </div>
          ) : (
            <WorkflowEditor wfId={targetId} onNewProject={onNewProject} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<SidePanelKey | null>(null);
  // 右侧边栏（检查器）开关从 viewStore 读取（持久化，记住上次状态）
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const examplesOpen = useWorkflowStore((s) => s.examplesOpen);
  const setExamplesOpen = useWorkflowStore((s) => s.setExamplesOpen);
  const [showSettings, setShowSettings] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const viewTheme = useViewStore((s) => s.theme);
  const setViewTheme = useViewStore((s) => s.setTheme);
  const workspaceMode = useViewStore((s) => s.workspaceMode);
  const setWorkspaceMode = useViewStore((s) => s.setWorkspaceMode);
  const [prompt, setPrompt] = useState<{ title: string; initial: string; onConfirm: (name: string) => void } | null>(null);
  const splitView = useViewStore((s) => s.splitView);
  const splitWfId = useViewStore((s) => s.splitWfId);
  const setSplitWfId = useViewStore((s) => s.setSplitWfId);
  // 允许从窗口外拖拽 .workflow.json 进入应用直接打开
  const { dragActive, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useWorkflowFileDrop();
  // 底侧边栏开关与高度从 viewStore 读取（持久化，记住上次状态）
  const panelOpen = useViewStore((s) => s.panelOpen);
  const togglePanel = useViewStore((s) => s.togglePanel);
  const panelH = useViewStore((s) => s.panelH);
  const setPanelH = useViewStore((s) => s.setPanelH);

  const projectOperationRef = useRef<ProjectOperation | null>(null);
  const getProjectOperation = (projectId: string | null, projectPath: string | null): ProjectOperation => {
    const existing = projectOperationRef.current;
    if (
      existing
      && existing.projectId === projectId
      && existing.projectPath === projectPath
      && !existing.controller.signal.aborted
    ) return existing;
    existing?.controller.abort();
    const next = { projectId, projectPath, controller: new AbortController() };
    projectOperationRef.current = next;
    return next;
  };
  const assertProjectOperation = (operation: ProjectOperation): void => {
    if (operation.controller.signal.aborted) {
      const error = new Error('项目 operation 已取消');
      error.name = 'AbortError';
      throw error;
    }
    const current = useWorkflowStore.getState();
    if (current.projectId !== operation.projectId || current.projectPath !== operation.projectPath) {
      operation.controller.abort();
      throw new Error('项目在异步 operation 期间发生切换');
    }
  };

  // 面板尺寸（可拖拽调节）
  const [leftW, setLeftW] = useState(248);
  const [rightW, setRightW] = useState(288);
  const [shortcutsH] = useState(208);

  const openPanel = (key: SidePanelKey) => setActivePanel(key);
  const closePanel = () => setActivePanel(null);

  const startProjectSession = (goal: string) => {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) return;
    const firstLine = normalizedGoal.split(/[\n。！？!?]/)[0]?.trim() || normalizedGoal;
    const projectName = firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
    const state = useWorkflowStore.getState();
    state.newProject(projectName || '未命名项目');
    const projectId = useWorkflowStore.getState().projectId;
    if (!projectId) return;
    const now = new Date().toISOString();
    const id = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { snapshot, events } = startProjectSessionCommand({
      projectId,
      sessionId: id,
      issueId: `issue-${id}`,
      projectName,
      goal: normalizedGoal,
      now,
    });
    recordProjectEvents(projectId, events);
    useWorkflowStore.getState().setProjectControl(snapshot);
  };

  const refreshWorkerCleanupProposals = async (
    session: NonNullable<Awaited<ReturnType<typeof ensureGuiDevSession>>>,
    runId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (signal?.aborted) return;
    const current = useWorkflowStore.getState();
    const persistedRun = current.workerRuns.find((item) => item.runId === runId);
    if (!persistedRun || current.workerRunRecoveries.some((item) => item.runId === runId)) {
      current.setWorkerCleanupProposals(
        current.workerCleanupProposals.filter((proposal) => proposal.runId !== runId),
      );
      return;
    }
    const run = getRestoredWorkerRunForCleanup({
      projectId: current.projectId ?? persistedRun.projectId,
      taskGraphs: current.projectControl.taskGraphs ?? [],
      run: persistedRun,
    });
    if (!run) {
      current.addLog('warn', `Worker cleanup proposal 已抑制：Run ${runId} 未通过 TaskGraph restore`);
      current.setWorkerCleanupProposals(
        current.workerCleanupProposals.filter((proposal) => proposal.runId !== runId),
      );
      return;
    }
    const proposals = await Promise.all(
      Object.values(run.tasks)
        .filter((task) => task.worktreePath)
        .map((task) => buildWorkerCleanupProposalSafely({
          run,
          task,
          acceptance: task.acceptanceId ? session.getAcceptance(task.acceptanceId) : undefined,
          sideEffects: current.workerRunSideEffects,
          isWorktreeTracked: (path) => session.manager.isTracked(path),
          computeWorktreeSignature: (path) => session.computeWorktreeSignature(path),
          computeBranchRevision: async (branch) => {
            const revision = await session.manager.getBranchRevision(branch);
            return revision ?? undefined;
          },
        })),
    );
    if (signal?.aborted) return;
    const latest = useWorkflowStore.getState();
    if (latest.projectId !== run.projectId) return;
    latest.setWorkerCleanupProposals([
      ...latest.workerCleanupProposals.filter((proposal) => proposal.runId !== runId),
      ...proposals,
    ]);
  };

  const restoreWorkerWorktrees = async (
    session: NonNullable<Awaited<ReturnType<typeof ensureGuiDevSession>>>,
    runs: readonly WorkerRunQueueState[],
    signal?: AbortSignal,
  ): Promise<void> => {
    for (const run of runs) {
      for (const task of Object.values(run.tasks)) {
        if (signal?.aborted) return;
        if (task.cleanupStatus === 'cleaned') continue;
        if (!task.worktreeId || !task.worktreePath || !task.branch || !task.baseRevision) continue;
        const restored = await session.manager.restore({
          id: task.worktreeId,
          path: task.worktreePath,
          branch: task.branch,
          baseRevision: task.baseRevision,
          branchRevision: task.branchRevision,
          createdAt: task.updatedAt,
          status: task.worktreeStatus ?? 'created',
        }, { signal });
        if (signal?.aborted) return;
        if (!restored) {
          useWorkflowStore.getState().addLog(
            'warn',
            `Worker worktree 未能从 git 恢复登记：${task.taskId}`,
          );
        }
      }
    }
  };

  const auditLoadedWorkerRunFacts = async (
    projectPath: string | null,
    acceptances?: readonly AcceptanceRecord[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!isTauri || !projectPath || signal?.aborted) return;
    try {
      const { createTauriEventStoreAdapter } = await import('./domain/tauriEventStore');
      const repository = new EventStreamRepository(
        createTauriEventStoreAdapter(projectPath),
        projectPath,
      );
      const before = useWorkflowStore.getState();
      if (!before.projectId || before.projectPath !== projectPath) return;
      const bootstrapped = await ensureProjectControlEventBaseline({
        repository,
        projectId: before.projectId,
        snapshot: before.projectControl,
        workerRuns: before.workerRuns,
        now: new Date().toISOString(),
      });
      if (signal?.aborted) return;
      const parsed = bootstrapped.stream;
      let current = useWorkflowStore.getState();
      if (!current.projectId || current.projectPath !== projectPath) return;
      const projectId = current.projectId;
      const reconciledSnapshots = reconcileWorkerRunsFromEvents({
        projectId,
        events: parsed.events,
        runs: current.workerRuns,
        taskGraphs: current.projectControl.taskGraphs ?? [],
      });
      if (reconciledSnapshots.issues.length > 0) {
        current.addLog(
          'warn',
          `Worker retry snapshot reconciliation 发现问题：${reconciledSnapshots.issues.map((item) => item.message).join('；')}`,
        );
      }
      if (reconciledSnapshots.changedRunIds.length > 0 && reconciledSnapshots.issues.length === 0) {
        current.setWorkerRuns(reconciledSnapshots.runs);
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, reconciledSnapshots.runs),
        );
        await current.saveProject({ projectId, projectPath, signal });
        if (signal?.aborted) return;
        current = useWorkflowStore.getState();
      }
      const rehydrated = current.workerRuns.length === 0
        ? rehydrateWorkerRunsFromEvents({
          projectId,
          events: parsed.events,
          taskGraphs: current.projectControl.taskGraphs ?? [],
          existingRuns: current.workerRuns,
        })
        : { runs: [], issues: [] };
      if (rehydrated.issues.length > 0) {
        current.addLog(
          'warn',
          `Worker Run 投影恢复被阻止：${rehydrated.issues.map((item) => item.message).join('；')}`,
        );
      } else if (rehydrated.runs.length > 0) {
        if (signal?.aborted) return;
        current.setWorkerRuns(rehydrated.runs);
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, rehydrated.runs),
        );
        await current.saveProject({
          projectId,
          projectPath,
          signal,
        });
        if (signal?.aborted) return;
        current = useWorkflowStore.getState();
      }
      let report: WorkerRunConsistencyReport;
      let controlReport: ReturnType<typeof auditProjectControlConsistency> | null = null;
      if (parsed.status === 'needs-repair') {
        const projection: DomainProjection = {
          lastSequence: 0,
          runs: {},
          tasks: {},
          taskExecutions: {},
          attempts: {},
        };
        report = {
          ok: false,
          projection,
          issues: [{
            code: 'invalid-event-stream',
            message: `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
          }],
        };
      } else {
        report = auditWorkerRunConsistency({
          projectId,
          runs: current.workerRuns,
          events: parsed.events,
          evidence: current.workerRunEvidence,
          acceptances,
          sideEffects: current.workerRunSideEffects,
          taskGraphs: current.projectControl.taskGraphs ?? [],
        });
        controlReport = auditProjectControlConsistency({
          projectId,
          snapshot: current.projectControl,
          events: parsed.events,
        });
        if (!controlReport.ok && current.workerRuns.length > 0) {
          report = {
            ...report,
            ok: false,
            issues: [
              ...report.issues,
              ...controlReport.issues.map((item) => ({
                code: 'control-state-drift' as const,
                message: `控制面事实审计未通过：${item.message}`,
              })),
            ],
          };
        }
      }
      if (signal?.aborted) return;
      const runtime = installWorkerRunRuntime({
        projectId,
        taskGraphs: current.projectControl.taskGraphs ?? [],
        runs: current.workerRuns,
        consistency: report,
      });
      current.setWorkerRunRecoveries(runtime.recoveries);
      const controlOk = controlReport === null || controlReport.ok;
      const hasWorkerProjection = current.workerRuns.length > 0
        || current.orchestrations.some((orchestration) => (
          orchestration.runIds.length > 0
          || Object.keys(orchestration.stageLogsByRun ?? {}).length > 0
        ));
      if (report.ok && controlOk && current.workerRuns.length > 0) {
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, current.workerRuns),
        );
      } else if (!report.ok || !controlOk || (hasWorkerProjection && current.workerRuns.length === 0)) {
        const reason = report.issues[0]?.message
          ?? controlReport?.issues[0]?.message
          ?? (current.workerRuns.length === 0 ? 'Worker Run registry empty during audit' : 'Worker facts audit failed');
        current.setOrchestrations(
          suppressInvalidWorkerRunProjection(current.orchestrations, `Worker facts invalid：${reason}`),
        );
      }
      if (!report.ok) {
        current.setWorkerCleanupProposals([]);
        current.addLog(
          'warn',
          `Worker 事实源审计未通过：${report.issues.map((item) => item.message).join('；')}`,
        );
      }
      if (controlReport && !controlReport.ok) {
        current.setWorkerCleanupProposals([]);
        current.addLog(
          'warn',
          `ProjectControl 事实审计未通过：${controlReport.issues.map((item) => item.message).join('；')}`,
        );
      }
    } catch (cause) {
      if (signal?.aborted) return;
      const failedState = useWorkflowStore.getState();
      const message = `Worker 事件流无法审计：${cause instanceof Error ? cause.message : String(cause)}`;
      failedState.setWorkerRunRecoveries(failedState.workerRuns.map((run): WorkerRunRecovery => ({
        runId: run.runId,
        projectId: run.projectId,
        reason: 'event-stream-invalid',
        message,
      })));
      failedState.setWorkerCleanupProposals([]);
      failedState.setOrchestrations(
        suppressInvalidWorkerRunProjection(failedState.orchestrations, `Worker facts invalid：${message}`),
      );
      failedState.addLog('warn', message);
    }
  };

  const runQueuedWorker = async (runId: string, workerRuntime: 'codex' | 'antigravity' = 'codex'): Promise<void> => {
    const beforeSave = useWorkflowStore.getState();
    const projectId = beforeSave.projectId;
    const projectPath = beforeSave.projectPath;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，Worker 才能创建隔离 worktree');
    const operation = getProjectOperation(projectId, projectPath);
    assertProjectOperation(operation);

    // queued 状态和 RunCreated/TaskQueued 事实先落盘；进程若在 Codex 启动前退出，重开仍能恢复该 Run。
    await beforeSave.saveProject({ projectId, projectPath, signal: operation.controller.signal });
    assertProjectOperation(operation);
    const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
    if (!session) {
      const reason = getDevGuiError();
      throw new Error(`开发宿主不可用，Worker 未启动${reason ? `：${reason}` : ''}`);
    }
    assertProjectOperation(operation);
    const current = useWorkflowStore.getState();
    if (current.projectId !== projectId) throw new Error('项目在 Worker 启动前发生切换');
    const [{ createTauriEventStoreAdapter }, { createTauriEvidenceStore }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
      import('./domain/tauriEventStore'),
      import('./dev/tauri-run'),
      import('./domain/sideEffects'),
      import('./projectControl/workerSideEffects'),
    ]);
    const sideEffectRepository = new sideEffectsModule.SideEffectJournalRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );
    const evidencePersistence = createTauriEvidenceStore(
      `${projectPath}/.slimemold/evidence`,
      `${projectPath}-workers`,
      'host',
    );
    const acceptanceVerifier = workerSideEffectsModule.createPersistedWorkerAcceptanceVerifier({
      load: async () => session.listAcceptances(),
    });
    const sideEffects = workerSideEffectsModule.createPersistedWorkerSideEffectRecorder(
      sideEffectRepository,
      evidencePersistence,
      undefined,
      acceptanceVerifier,
    );
    assertProjectOperation(operation);
    const eventRepository = new EventStreamRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );

    const antigravityAgent = [...current.globalAgents, ...current.agents].find(
      (agent) => agent.protocol === 'antigravity' && agent.enabled !== false,
    );
    const coordinator = createGuiProjectWorkerRunCoordinator({
      projectId,
      projectPath,
      runs: current.workerRuns,
      session,
      workerRuntime,
      antigravity: antigravityAgent
        ? {
          mode: antigravityAgent.runtimeMode,
          profile: antigravityAgent.runtimeProfile,
          cliPath: antigravityAgent.runtimeCliPath,
        }
        : undefined,
      concurrency: current.maxConcurrency,
      sideEffects,
      signal: operation.controller.signal,
      assertConsistency: async () => {
        assertProjectOperation(operation);
        const parsed = await eventRepository.readStream();
        assertProjectOperation(operation);
        if (parsed.status === 'needs-repair') {
          throw new Error(
            `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
          );
        }
        const current = useWorkflowStore.getState();
        assertProjectOperation(operation);
        const report = auditWorkerRunConsistency({
          projectId,
          runs: current.workerRuns,
          events: parsed.events,
          evidence: current.workerRunEvidence,
          acceptances: session.listAcceptances(),
          sideEffects: current.workerRunSideEffects,
          taskGraphs: current.projectControl.taskGraphs ?? [],
        });
        if (!report.ok) {
          throw new Error(`Worker 事实源不一致：${report.issues.map((item) => item.message).join('；')}`);
        }
        const controlReport = auditProjectControlConsistency({
          projectId,
          snapshot: current.projectControl,
          events: parsed.events,
        });
        if (!controlReport.ok) {
          throw new Error(`ProjectControl 事实源不一致：${controlReport.issues.map((item) => item.message).join('；')}`);
        }
      },
      persistTransition: async ({ state, events }) => {
        const terminalTaskEvents = new Set(['TaskSucceeded', 'TaskFailed', 'TaskBlocked']);
        const safeFinalizationEvents = new Set([
          'RunCreated',
          'TaskQueued',
          'RunStarted',
          'TaskStarted',
          'TaskSucceeded',
          'TaskFailed',
          'TaskBlocked',
          'RunSucceeded',
          'RunFailed',
          'RunCancelled',
          'RunBlocked',
        ]);
        const terminalFinalization = events.some((event) => terminalTaskEvents.has(event.eventType))
          && events.every((event) => safeFinalizationEvents.has(event.eventType));
        if (operation.controller.signal.aborted && terminalFinalization) {
          recordProjectEvents(projectId, events);
          await flushPendingProjectEvents(projectId, eventRepository);
          const oldRuns = beforeSave.workerRuns.map((run) => run.runId === state.runId ? state : run);
          await saveProjectFile(
            buildProjectFile({ ...beforeSave, workerRuns: oldRuns }),
            projectPath,
          );
          return;
        }
        assertProjectOperation(operation);
        const latest = useWorkflowStore.getState();
        assertProjectOperation(operation);
        recordProjectEvents(projectId, events);
        const nextRuns = latest.workerRuns.map((run) => run.runId === state.runId ? state : run);
        latest.setWorkerRuns(nextRuns);
        latest.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(latest.orchestrations, nextRuns),
        );
        latest.setWorkerRunEvidence(mergeWorkerEvidence(latest.workerRunEvidence, session.collector.records));
        const effectRecords = await loadWorkerSideEffects(sideEffectRepository);
        assertProjectOperation(operation);
        latest.setWorkerRunSideEffects(mergeWorkerSideEffects(latest.workerRunSideEffects, effectRecords));
        await latest.saveProject({ projectId, projectPath, signal: operation.controller.signal });
        assertProjectOperation(operation);
      },
    });
    assertProjectOperation(operation);
    await coordinator.run(runId);
    assertProjectOperation(operation);
    await refreshWorkerCleanupProposals(session, runId, operation.controller.signal);
  };

  const recoverInterruptedWorkerEffects = async (
    projectPath: string | null,
    runIds: string[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!isTauri || !projectPath || runIds.length === 0 || signal?.aborted) return;
    try {
      const [{ createTauriEventStoreAdapter }, { createTauriEvidenceStore }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
        import('./domain/tauriEventStore'),
        import('./dev/tauri-run'),
        import('./domain/sideEffects'),
        import('./projectControl/workerSideEffects'),
      ]);
      const session = await ensureGuiDevSession(projectPath, signal);
      if (!session) throw new Error('开发宿主不可用，无法恢复 Worker Acceptance');
      const persistence = createTauriEvidenceStore(
        `${projectPath}/.slimemold/evidence`,
        `${projectPath}-workers`,
        'host',
      );
      const acceptanceVerifier = workerSideEffectsModule.createPersistedWorkerAcceptanceVerifier({
        load: async () => session.listAcceptances(),
      });
      const recorder = workerSideEffectsModule.createPersistedWorkerSideEffectRecorder(
        new sideEffectsModule.SideEffectJournalRepository(
          createTauriEventStoreAdapter(projectPath),
          projectPath,
        ),
        persistence,
        undefined,
        acceptanceVerifier,
      );
      for (const runId of runIds) {
        if (signal?.aborted) return;
        await recorder.recoverInterruptedRun(runId, { signal });
      }
    } catch (cause) {
      if (signal?.aborted) return;
      // Recovery is fail-closed: keep the visible recovery record when the journal cannot be read/repaired.
      useWorkflowStore.getState().addLog(
        'warn',
        `Worker 副作用账本无法完成恢复核对：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const loadProjectWorkerEvidence = async (projectPath: string | null, signal?: AbortSignal): Promise<void> => {
    if (!isTauri || !projectPath || signal?.aborted) return;
    try {
      const [{ createTauriEvidenceStore }, { createTauriEventStoreAdapter }, sideEffectsModule] = await Promise.all([
        import('./dev/tauri-run'),
        import('./domain/tauriEventStore'),
        import('./domain/sideEffects'),
      ]);
      const persistence = createTauriEvidenceStore(
        `${projectPath}/.slimemold/evidence`,
        `${projectPath}-workers`,
        'host',
      );
      const sideEffectRepository = new sideEffectsModule.SideEffectJournalRepository(
        createTauriEventStoreAdapter(projectPath),
        projectPath,
      );
      if (signal?.aborted) return;
      const records = await loadWorkerEvidence(persistence);
      if (signal?.aborted) return;
      const effects = await loadWorkerSideEffects(sideEffectRepository);
      if (signal?.aborted) return;
      const current = useWorkflowStore.getState();
      if (current.projectPath === projectPath) {
        const mergedEffects = mergeWorkerSideEffects(current.workerRunSideEffects, effects);
        const reconciled = reconcileSuccessfulCleanupReceipts(current.workerRuns, mergedEffects);
        current.setWorkerRunEvidence(mergeWorkerEvidence(current.workerRunEvidence, records));
        current.setWorkerRunSideEffects(mergedEffects);
        if (reconciled.events.length > 0 && current.projectId) {
          recordProjectEvents(current.projectId, reconciled.events);
          current.setWorkerRuns(reconciled.runs);
          current.setOrchestrations(
            projectWorkerRunsOntoOrchestrations(current.orchestrations, reconciled.runs),
          );
          await current.saveProject({ projectId: current.projectId, projectPath, signal });
        }
        const cleanupUnknownRuns = cleanupUnknownRunIds(mergedEffects);
        if (cleanupUnknownRuns.size > 0) {
          current.setWorkerRunRecoveries([
            ...current.workerRunRecoveries.filter((item) => !cleanupUnknownRuns.has(item.runId)),
            ...current.workerRuns
              .filter((run) => cleanupUnknownRuns.has(run.runId))
              .map((run): WorkerRunRecovery => ({
                runId: run.runId,
                projectId: run.projectId,
                reason: 'cleanup-unknown',
                message: 'Cleanup 副作用为 unknown/needs-user，必须人工核对后才能继续。',
              })),
          ]);
          current.setWorkerCleanupProposals(
            current.workerCleanupProposals.filter((proposal) => !cleanupUnknownRuns.has(proposal.runId)),
          );
        }
      }
    } catch (cause) {
      if (signal?.aborted) return;
      const failedState = useWorkflowStore.getState();
      const message = `Worker Evidence/Receipt reconciliation 无法持久化：${cause instanceof Error ? cause.message : String(cause)}`;
      failedState.setWorkerRunRecoveries(failedState.workerRuns.map((run): WorkerRunRecovery => ({
        runId: run.runId,
        projectId: run.projectId,
        reason: 'event-stream-invalid',
        message,
      })));
      failedState.setWorkerCleanupProposals([]);
      useWorkflowStore.getState().addLog(
        'warn',
        message,
      );
      throw cause;
    }
  };

  const recoverWorkerRun = async (
    runId: string,
    decision: 'retry' | 'skip',
    reason: string,
  ): Promise<void> => {
    if (!isTauri) throw new Error('Worker recovery 需要桌面端项目环境');
    const current = useWorkflowStore.getState();
    const projectId = current.projectId;
    const projectPath = current.projectPath;
    const run = current.workerRuns.find((item) => item.runId === runId);
    const taskGraph = run
      ? current.projectControl.taskGraphs?.find((item) => item.id === run.taskGraphId)
      : undefined;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，才能恢复 Worker Run');
    if (!run || !taskGraph) throw new Error(`找不到可恢复的 Worker Run：${runId}`);
    const operation = getProjectOperation(projectId, projectPath);
    assertProjectOperation(operation);

    const [{ createTauriEventStoreAdapter }, { createTauriEvidenceStore }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
      import('./domain/tauriEventStore'),
      import('./dev/tauri-run'),
      import('./domain/sideEffects'),
      import('./projectControl/workerSideEffects'),
    ]);
    const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
    if (!session) throw new Error('开发宿主不可用，无法恢复 Worker Acceptance');
    const persistence = createTauriEvidenceStore(
      `${projectPath}/.slimemold/evidence`,
      `${projectPath}-workers`,
      'host',
    );
    const acceptanceVerifier = workerSideEffectsModule.createPersistedWorkerAcceptanceVerifier({
      load: async () => session.listAcceptances(),
    });
    const recorder = workerSideEffectsModule.createPersistedWorkerSideEffectRecorder(
      new sideEffectsModule.SideEffectJournalRepository(
        createTauriEventStoreAdapter(projectPath),
        projectPath,
      ),
      persistence,
      undefined,
      acceptanceVerifier,
    );
    assertProjectOperation(operation);
    const journal = await recorder.recoverInterruptedRun(runId, { signal: operation.controller.signal });
    assertProjectOperation(operation);
    current.setWorkerRunSideEffects(mergeWorkerSideEffects(current.workerRunSideEffects, journal.entries));
    const decisionId = globalThis.crypto?.randomUUID?.() ?? `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = recoverWorkerRunCommand({
      projectId,
      state: run,
      taskGraph,
      journal,
      decision,
      reason,
      decisionId,
      now: new Date().toISOString(),
    });
    assertProjectOperation(operation);
    recordProjectEvents(projectId, result.events);
    const nextRuns = current.workerRuns.map((item) => item.runId === runId ? result.state : item);
    current.setWorkerRuns(nextRuns);
    current.setOrchestrations(
      projectWorkerRunsOntoOrchestrations(current.orchestrations, nextRuns),
    );
    current.setWorkerCleanupProposals(current.workerCleanupProposals.filter((proposal) => proposal.runId !== runId));
    const runtime = installWorkerRunRuntime({
      projectId,
      taskGraphs: current.projectControl.taskGraphs ?? [],
      runs: current.workerRuns.map((item) => item.runId === runId ? result.state : item),
    });
    current.setWorkerRunRecoveries(runtime.recoveries);
    assertProjectOperation(operation);
    await current.saveProject({ projectId, projectPath, signal: operation.controller.signal });
    assertProjectOperation(operation);
    if (decision === 'retry') await runQueuedWorker(runId);
  };

  const cleanupWorkerRun = async (
    runId: string,
    taskId: string,
    action: 'approve' | 'cleanup',
  ): Promise<void> => {
    if (!isTauri) throw new Error('Worker cleanup 需要桌面端项目环境');
    const current = useWorkflowStore.getState();
    const projectId = current.projectId;
    const projectPath = current.projectPath;
    const proposal = current.workerCleanupProposals.find(
      (item) => item.runId === runId && item.taskId === taskId,
    );
    if (!projectId || !projectPath) throw new Error('项目必须先保存，才能清理 Worker worktree');
    if (!proposal || proposal.status !== 'ready') throw new Error(`清理提案不可用：${runId}/${taskId}`);
    if (current.workerRunRecoveries.some((item) => item.runId === runId)) {
      throw new Error(`Worker Run ${runId} 存在 restore recovery，拒绝清理`);
    }
    const persistedRun = current.workerRuns.find((item) => item.runId === runId);
    const trustedRun = persistedRun
      ? getRestoredWorkerRunForCleanup({
        projectId,
        taskGraphs: current.projectControl.taskGraphs ?? [],
        run: persistedRun,
      })
      : null;
    const trustedTask = trustedRun?.tasks[taskId];
    const expectedStageId = trustedTask?.acceptanceStageId ?? taskId;
    const trustedTaskExecutionId = trustedTask?.taskExecutionId ?? createTaskExecutionId(runId, taskId);
    const trustedAttemptId = trustedTask
      ? trustedTask.currentAttemptId ?? createAttemptId(trustedTaskExecutionId, trustedTask.attempt)
      : undefined;
    const isDurableBranchCleanup = trustedTask?.worktreeStatus === 'orphaned'
      || trustedTask?.worktreeStatus === 'registration-pending';
    const expectedOrchestrationId = persistedRun?.orchestrationId ?? runId;
    if (!trustedTask
      || trustedTask.status !== 'succeeded'
      || trustedTask.cleanupStatus === 'cleaned'
      || proposal.attempt !== trustedTask.attempt
      || proposal.taskExecutionId !== trustedTaskExecutionId
      || proposal.attemptId !== trustedAttemptId
      || proposal.worktreeId !== trustedTask.worktreeId
      || proposal.worktreePath !== trustedTask.worktreePath
      || proposal.branch !== trustedTask.branch
      || proposal.baseRevision !== trustedTask.baseRevision
      || proposal.acceptanceId !== trustedTask.acceptanceId
      || proposal.stageId !== expectedStageId
      || proposal.orchestrationId !== expectedOrchestrationId
      || (isDurableBranchCleanup && proposal.branchRevision !== trustedTask.branchRevision)
      || (isDurableBranchCleanup && proposal.stateSignature !== trustedTask.cleanupStateSignature)
      || proposal.taskStatus !== 'succeeded'
      || proposal.cleanupStatus !== 'active') {
      throw new Error(`Worker cleanup proposal 未通过当前 TaskGraph restore 校验：${runId}/${taskId}`);
    }
    const operation = getProjectOperation(projectId, projectPath);
    assertProjectOperation(operation);
    const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
    if (!session) throw new Error('开发宿主不可用，Worker cleanup 未执行');
    assertProjectOperation(operation);
    if (!proposal.branchRevisionRequired || !proposal.branchRevision) {
      throw new Error(`Worker cleanup proposal 缺少强制 branch CAS：${runId}/${taskId}`);
    }
    if (isDurableBranchCleanup) {
      if (proposal.branchRevision !== trustedTask.branchRevision) {
        throw new Error(`Worker cleanup durable branch revision 已漂移：${runId}/${taskId}`);
      }
    } else {
      const liveBranchRevision = await session.manager.getBranchRevision(trustedTask.branch);
      if (liveBranchRevision !== proposal.branchRevision) {
        throw new Error(`Worker cleanup live branch revision 已漂移：${runId}/${taskId}`);
      }
    }
    const persistCleanupState = async (
      nextRuns: WorkerRunQueueState[],
    ): Promise<void> => {
      const latest = useWorkflowStore.getState();
      const sameProject = latest.projectId === projectId && latest.projectPath === projectPath;
      if (sameProject) {
        // Receipt 已经 durable 后，不再把当前 operation 的 cancellation 当作阻断条件。
        await latest.saveProject();
      } else {
        const [{ createTauriEventStoreAdapter }] = await Promise.all([
          import('./domain/tauriEventStore'),
        ]);
        await flushPendingProjectEvents(
          projectId,
          new EventStreamRepository(createTauriEventStoreAdapter(projectPath), projectPath),
        );
        await saveProjectFile(buildProjectFile({
          ...current,
          workerRuns: nextRuns,
          orchestrations: projectWorkerRunsOntoOrchestrations(current.orchestrations, nextRuns),
        }), projectPath);
      }
      const { openProjectByPath } = await import('./io/projectIO');
      const persisted = await openProjectByPath(projectPath);
      const expected = nextRuns.find((item) => item.runId === runId)?.tasks[taskId];
      const actual = (persisted?.workerRuns ?? []).find((item) => item.runId === runId)?.tasks[taskId];
      const projection = (task: typeof expected) => task && ({
        status: task.status,
        worktreeStatus: task.worktreeStatus,
        branchRevision: task.branchRevision,
        cleanupStateSignature: task.cleanupStateSignature,
        cleanupStatus: task.cleanupStatus,
        cleanupReceiptId: task.cleanupReceiptId,
      });
      if (!expected || !actual || JSON.stringify(projection(actual)) !== JSON.stringify(projection(expected))) {
        throw new Error(`Worker cleanup ProjectFile read-back 不一致：${runId}/${taskId}`);
      }
    };

    if (action === 'approve') {
      approveWorkerCleanupProposal(proposal, session);
      session.registerTrustedCleanupBinding(proposal);
      assertProjectOperation(operation);
      current.setWorkerCleanupProposals(current.workerCleanupProposals.map((item) => (
        item.runId === runId && item.taskId === taskId && item.status === 'ready'
          ? { ...item, approvalStatus: 'approved' }
          : item
      )));
      return;
    }
    if (proposal.approvalStatus !== 'approved') {
      throw new Error('清理前必须先完成显式批准');
    }

    const [{ createTauriEventStoreAdapter }, sideEffectsModule] = await Promise.all([
      import('./domain/tauriEventStore'),
      import('./domain/sideEffects'),
    ]);
    const repository = new sideEffectsModule.SideEffectJournalRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );
    assertProjectOperation(operation);
    const cleanupResult = await executeWorkerCleanupWithReceipt({
      proposal,
      repository,
      host: session,
      now: new Date().toISOString(),
      signal: operation.controller.signal,
    });
    const cleanupSideEffects = mergeWorkerSideEffects(
      current.workerRunSideEffects,
      [cleanupResult.sideEffect],
    );
    const sameProjectAtReceipt = useWorkflowStore.getState().projectId === projectId
      && useWorkflowStore.getState().projectPath === projectPath;
    if (sameProjectAtReceipt) current.setWorkerRunSideEffects(cleanupSideEffects);
    if (!cleanupResult.cleaned) {
      current.setWorkerRunRecoveries([
        ...current.workerRunRecoveries.filter((item) => item.runId !== runId),
        {
          runId,
          projectId,
          reason: 'cleanup-unknown',
          message: 'Cleanup host gate rejected or drifted; side effect is unknown/needs-user.',
        },
      ]);
      current.setWorkerCleanupProposals(
        current.workerCleanupProposals.filter((item) => item.runId !== runId),
      );
      const pendingRun = current.workerRuns.find((item) => item.runId === runId);
      const pendingInfo = session.manager.getByPath(proposal.worktreePath);
      if (!pendingRun || !pendingInfo) {
        throw new Error('宿主 cleanup 未完成且缺少可恢复的 Worker 状态');
      }
      const pendingRuns = current.workerRuns.map((item) => item.runId === runId
        ? {
          ...item,
          tasks: {
            ...item.tasks,
            [taskId]: {
              ...item.tasks[taskId],
              worktreeStatus: pendingInfo.status,
              branchRevision: pendingInfo.branchRevision,
              cleanupStateSignature: proposal.stateSignature,
              updatedAt: new Date().toISOString(),
            },
          },
        }
        : item);
      if (sameProjectAtReceipt) {
        current.setWorkerRuns(pendingRuns);
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, pendingRuns),
        );
      }
      await persistCleanupState(pendingRuns);
      throw new Error('宿主 cleanup 未完成，副作用已标记为 unknown，需要人工核对');
    }

    const run = current.workerRuns.find((item) => item.runId === runId);
    if (!run) throw new Error(`找不到 Worker Run：${runId}`);
    const cleaned = markWorkerTaskCleaned({
      state: run,
      taskId,
      receiptId: cleanupResult.sideEffect.receipt?.receiptId ?? '',
      taskExecutionId: proposal.taskExecutionId,
      attemptId: proposal.attemptId,
      stateSignature: proposal.stateSignature,
      receipt: cleanupResult.sideEffect,
      decisionId: globalThis.crypto?.randomUUID?.() ?? `cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      now: new Date().toISOString(),
    });
    recordProjectEvents(projectId, cleaned.events);
    const nextRuns = current.workerRuns.map((item) => item.runId === runId ? cleaned.state : item);
    if (sameProjectAtReceipt) {
      current.setWorkerRuns(nextRuns);
      current.setOrchestrations(
        projectWorkerRunsOntoOrchestrations(current.orchestrations, nextRuns),
      );
    }
    await persistCleanupState(nextRuns);
    await refreshWorkerCleanupProposals(session, runId, operation.controller.signal);
  };

  const toggleTheme = () => {
    // 三态循环：dark -> light -> system -> dark
    const next = viewTheme === 'dark' ? 'light' : viewTheme === 'light' ? 'system' : 'dark';
    setViewTheme(next);
  };

  // setTheme 已在 store 内套用 data-theme（含 system 跟随），此处无需再手动设置

  // 拖拽分隔条
  const startResize = (
    axis: 'x' | 'y',
    side: 'left' | 'right' | 'bottom',
    initial: number,
  ) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = initial;

    const onMove = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
      // left/right 分隔条向右拖拽 = 宽度增大；bottom 分隔条向上拖拽 = 高度增大
      const sign = side === 'bottom' ? -1 : 1;
      let next = startSize + sign * delta;
      next = Math.max(160, Math.min(480, next));
      if (side === 'bottom') next = Math.max(120, Math.min(480, next));
      if (side === 'left') setLeftW(next);
      else if (side === 'right') setRightW(next);
      else setPanelH(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    // 桌面端启动时自动扫描插件目录
    if (isTauri) scanPluginsDir();
    // 启动时从 AppData 加载全局通用智能体（跨项目共享）到 store
    loadGlobalAgents().then((gs) => {
      if (gs.length > 0) useWorkflowStore.getState().setGlobalAgents(gs);
    });
  }, []);

  // P3：桌面端启动自动恢复上次项目（含激活工作流），仅当当前尚无已加载项目时
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    (async () => {
      const sess = getLastSession();
      if (!sess) return;
      const st = useWorkflowStore.getState();
      // 已有项目（如持久化恢复）则不抢占
      if (st.projectId) return;
      try {
        // 工作区信任：在任何 fs 访问之前，先把项目根目录动态注入 fs:scope
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('grant_project_access', { path: sess.path }).catch(() => {});
        if (cancelled || useWorkflowStore.getState().projectId) return;
        const fs = await import('@tauri-apps/plugin-fs');
        const ok = await fs.exists(sess.path);
        if (!ok || cancelled || useWorkflowStore.getState().projectId) return;
        const { openProjectByPath } = await import('./io/projectIO');
        const file = await openProjectByPath(sess.path);
        if (!file || cancelled || useWorkflowStore.getState().projectId) return;
        // 优先恢复会话里记录的激活工作流
        if (sess.activeId && file.workflows[sess.activeId]) {
          file.activeId = sess.activeId;
        }
        useWorkflowStore.getState().openProject(file, sess.path);
        // 项目恢复成功后：扫描程序级（全局）自定义节点；项目级（仅本项目）由下方 projectId 订阅统一触发
        void scanProgramCustomNodes().catch(() => {});
      } catch {
        /* 恢复失败不阻塞启动 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // P3 项目欢迎页：当前无项目加载时弹出（项目加载后自动隐藏，关闭项目后重新出现）
  const [showWelcome, setShowWelcome] = useState(() => !useWorkflowStore.getState().projectId);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    const projectLifecycle = createProjectLifecycleController({
      getState: () => useWorkflowStore.getState(),
      subscribe: (listener) => useWorkflowStore.subscribe(listener),
      setShowWelcome,
      getProjectOperation,
      clearProjectOperation: () => {
        projectOperationRef.current?.controller.abort();
        projectOperationRef.current = null;
      },
      restoreWorkerWorktrees,
      loadProjectWorkerEvidence,
      auditLoadedWorkerRunFacts,
      refreshWorkerCleanupProposals,
      recoverInterruptedWorkerEffects,
    });
    projectLifecycle.start();
    return () => projectLifecycle.dispose();
  }, []);


  // 全局快捷键（与菜单标注一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const inEditable =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportWorkflow();
      } else if (mod && e.key.toLowerCase() === 'z') {
        // 在输入框里不拦截，保留浏览器默认的文本撤销
        if (inEditable) return;
        e.preventDefault();
        if (e.shiftKey) useWorkflowStore.getState().redo();
        else useWorkflowStore.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().redo();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useWorkflowStore.getState().newWorkflowInProject();
      } else if (mod && e.key.toLowerCase() === 'c') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().copySelection();
      } else if (mod && e.key.toLowerCase() === 'v') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().pasteClipboard();
      } else if (mod && e.key.toLowerCase() === 'd') {
        if (inEditable) return;
        e.preventDefault();
        e.stopPropagation();
        useWorkflowStore.getState().duplicateSelection();
      } else if (mod && e.key.toLowerCase() === 'a') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().selectAll();
      } else if (mod && e.key.toLowerCase() === 'b') {
        if (inEditable) return;
        e.preventDefault();
        const st = useWorkflowStore.getState();
        st.nodes.filter((n) => n.selected).forEach((n) => st.toggleNodeBypass(n.id));
      } else if (mod && e.key.toLowerCase() === 'm') {
        if (inEditable) return;
        e.preventDefault();
        const st = useWorkflowStore.getState();
        st.nodes.filter((n) => n.selected).forEach((n) => st.toggleNodeMute(n.id));
      } else if (mod && e.key.toLowerCase() === 'g') {
        // Ctrl+G 把选中节点编为一组；Ctrl+Shift+G 打包成可复用子图
        e.preventDefault();
        const st = useWorkflowStore.getState();
        const ids = st.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length === 0) {
          st.addLog('error', '请先框选若干节点，再按 Ctrl+G');
          return;
        }
        if (e.shiftKey) {
          setPrompt({
            title: '给这个子图起个名字',
            initial: `子图 ${Object.keys(st.subgraphs).length + 1}`,
            onConfirm: (name) => st.packSelectionAsSubgraph(ids, name),
          });
        } else {
          st.createGroup(ids);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ReactFlowProvider>
      <div
        className={`flex h-screen flex-col font-app bg-sm-bg text-sm-ink ${workspaceMode === 'advanced' ? 'sm-pro-shell' : 'sm-simple-root'}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <WindowTitleBar />
        <div className="sm-app-content">
          {workspaceMode === 'simple' ? (
            <BeginnerExperience
              onOpenAdvanced={() => setWorkspaceMode('advanced')}
              onNewProject={() => setNewProjectOpen(true)}
              onStartProjectSession={startProjectSession}
              onRunWorker={isTauri ? runQueuedWorker : undefined}
              onRecoverWorkerRun={isTauri ? recoverWorkerRun : undefined}
            />
          ) : (
            <>
            <TopBar
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              panelOpen={panelOpen}
              onTogglePanel={togglePanel}
              inspectorOpen={inspectorOpen}
              onToggleInspector={toggleInspector}
              onOpenPanel={openPanel}
              onOpenShortcuts={() => setShowShortcutsModal(true)}
              onNewProject={() => setNewProjectOpen(true)}
              onOpenWizard={() => setWizardOpen(true)}
              onOpenSimpleView={() => setWorkspaceMode('simple')}
            />
            <main className="sm-pro-main flex flex-1 overflow-hidden">
          {/* 通栏图标条：贯穿整个高度，底部面板在其右侧打开，永不被遮盖 */}
          {sidebarOpen && (
            <SideRail
              active={activePanel}
              onClose={closePanel}
              onOpen={openPanel}
              onOpenExamples={() => setExamplesOpen(true)}
              examplesActive={examplesOpen}
              onOpenSettings={() => setShowSettings(true)}
              onToggleTheme={toggleTheme}
              shortcutsOpen={shortcutsOpen}
              onToggleShortcuts={() => setShortcutsOpen((v) => !v)}
              panelOpen={panelOpen}
              onTogglePanel={togglePanel}
            />
          )}
          {/* 内容区：展开面板 + 画布 + Inspector + 底部面板（均位于图标条右侧） */}
          <div className="sm-pro-content flex min-w-0 flex-1 flex-col overflow-x-visible overflow-y-hidden">
            <div className={`sm-pro-stage flex min-h-0 flex-1 ${activePanel === 'agents' ? 'overflow-visible' : 'overflow-hidden'}`}>
              {sidebarOpen && activePanel && (
                <>
                  <SidePanel
                    active={activePanel}
                    width={leftW}
                    onResize={setLeftW}
                    onClose={closePanel}
                    onRecoverWorkerRun={isTauri ? recoverWorkerRun : undefined}
                    onCleanupWorkerRun={isTauri ? cleanupWorkerRun : undefined}
                  />
                  <div
                    className="sm-pro-resize-handle sm-pro-resize-handle-x w-1 shrink-0 cursor-col-resize hover:bg-accent-soft bg-sm-line"
                    onPointerDown={startResize('x', 'left', leftW)}
                    title="拖动调节展开面板宽度"
                  />
                </>
              )}
          <div className="sm-pro-canvas-region flex min-w-0 flex-1">
              {splitView ? (
                <SplitCanvas
                  splitWfId={splitWfId}
                  setSplitWfId={setSplitWfId}
                  onNewProject={() => setNewProjectOpen(true)}
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <WorkflowEditor onNewProject={() => setNewProjectOpen(true)} />
                </div>
              )}
            </div>
            {inspectorOpen && (
              <>
                <Inspector width={rightW} />
                <div
                  className="sm-pro-resize-handle sm-pro-resize-handle-x w-1 shrink-0 cursor-col-resize hover:bg-accent-soft bg-sm-line"
                  onPointerDown={startResize('x', 'right', rightW)}
                  title="拖动调节属性面板宽度"
                />
              </>
            )}
            </div>
            {/* 底部面板：仅在图标条右侧的内容区出现，不遮盖图标条 */}
            {shortcutsOpen && (
              <>
                <div
                  className="sm-pro-resize-handle sm-pro-resize-handle-y h-1 shrink-0 cursor-row-resize hover:bg-accent-soft bg-sm-line"
                  onPointerDown={startResize('y', 'bottom', shortcutsH)}
                  title="拖动调节快捷键面板高度"
                />
                <div className="sm-panel shrink-0 text-sm-ink-soft">
                  <div className="sm-panel-tabs">
                    <button className="sm-panel-tab" data-active={true}>
                      <Keyboard size={12} /> 快捷键
                    </button>
                    <div className="flex flex-1 items-center justify-end">
                      <button
                        className="flex cursor-pointer items-center gap-1 border-l border-sm-line px-3 text-[11px] text-sm-ink-faint transition-colors hover:text-ink"
                        onClick={() => setShortcutsOpen(false)}
                        title="关闭快捷键面板"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  <ShortcutsModal inline />
                </div>
              </>
            )}
            {panelOpen && (
              <>
                <div
                  className="sm-pro-resize-handle sm-pro-resize-handle-y h-1 shrink-0 cursor-row-resize hover:bg-accent-soft bg-sm-line"
                  onPointerDown={startResize('y', 'bottom', panelH)}
                  title="拖动调节底部面板高度"
                />
                <StatusBar open={panelOpen} height={panelH} onToggle={togglePanel} />
              </>
            )}
          </div>
            </main>
            {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
            {showSettings && <SettingsCenter onClose={() => setShowSettings(false)} />}
            {examplesOpen && <ExamplesModal onClose={() => setExamplesOpen(false)} />}
            {wizardOpen && <WorkflowWizard onClose={() => setWizardOpen(false)} />}
            {prompt && (
              <NamePrompt
                title={prompt.title}
                initial={prompt.initial}
                onConfirm={(name) => {
                  prompt.onConfirm(name);
                  setPrompt(null);
                }}
                onCancel={() => setPrompt(null)}
              />
            )}
            {shouldRenderWelcomeModal(workspaceMode, showWelcome) && (
              <WelcomeModal onClose={() => setShowWelcome(false)} onNewProject={() => setNewProjectOpen(true)} />
            )}
            </>
          )}
        </div>
        {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} />}
        {/* 阶段 D 实时接管：节点请求人工介入时浮出，提交/取消放行挂起的执行 */}
        <InterventionModal />
        {dragActive && (
          <div
            className="pointer-events-none fixed inset-0 z-fatal flex items-center justify-center"
            style={{
              background: 'color-mix(in srgb, var(--sm-bg) 70%, transparent)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <div
              className="rounded-lg border-2 border-dashed border-sm-accent px-10 py-8 text-center text-[15px] font-semibold text-sm-accent"
            >
              松开以打开工作流文件 (.workflow.json)
            </div>
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
}
