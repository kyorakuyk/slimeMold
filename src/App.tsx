import { useEffect, useState } from 'react';
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
import { scanPluginsDir, scanProgramCustomNodes, scanProjectCustomNodes, terminatePluginRuntime, unloadProjectCustomNodes } from './plugins/pluginManager';
import { createProjectPluginLifecycleScheduler } from './plugins/projectPluginLifecycle';
import { isTauri } from './platform/env';
import { getLastSession } from './io/projectIO';
import { exportWorkflow } from './io/workflowIO';
import { useWorkflowStore } from './store/workflowStore';
import { shouldRenderWelcomeModal, useViewStore } from './store/viewStore';
import { loadGlobalAgents } from './agents/globalAgents';
import { useWorkflowFileDrop } from './hooks/useWorkflowFileDrop';
import { ensureGuiDevSession, teardownGuiDevSession } from './dev/gui';
import { startProjectSessionCommand } from './projectControl/commands';
import { recordProjectEvents } from './projectControl/eventBuffer';
import { createGuiProjectWorkerRunCoordinator } from './projectControl/workerRunCoordinator';
import { recoverWorkerRunCommand } from './projectControl/workerRecoveryCommand';
import { installWorkerRunRuntime } from './projectControl/workerRunRuntime';
import {
  approveWorkerCleanupProposal,
  buildWorkerCleanupProposal,
} from './projectControl/workerCleanup';
import { executeWorkerCleanupWithReceipt } from './projectControl/workerCleanupExecution';
import { markWorkerTaskCleaned } from './projectControl/workerCleanupCommand';
import { auditWorkerRunConsistency } from './projectControl/workerRunConsistency';
import { ensureProjectControlEventBaseline } from './projectControl/eventSourceBootstrap';
import { auditProjectControlConsistency } from './projectControl/projectControlConsistency';
import { projectWorkerRunsOntoOrchestrations } from './projectControl/workerRunOrchestrationProjection';
import type { WorkerRunQueueState } from './domain/workerQueue';
import type { WorkerRunConsistencyReport } from './projectControl/workerRunConsistency';
import type { DomainProjection } from './domain/contracts';
import { EventStreamRepository } from './domain/eventStore';
import {
  loadWorkerEvidence,
  loadWorkerSideEffects,
  mergeWorkerEvidence,
  mergeWorkerSideEffects,
} from './projectControl/workerEvidence';

registerBuiltins();

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
      <div className="min-w-0 flex-1 border-r" style={{ borderColor: 'var(--sm-line)' }}>
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[12px]"
          style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
        >
          <span className="font-semibold" style={{ color: 'var(--sm-ink)' }}>主工作流</span>
          <span className="truncate" style={{ color: 'var(--sm-ink-faint)' }}>
            {workflows[activeWfId]?.name ?? ''}
          </span>
        </div>
        <div className="h-[calc(100%-1.75rem)]">
          <WorkflowEditor onNewProject={onNewProject} />
        </div>
      </div>

      {/* 右：另一个工作流（可在下拉中切换） */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--sm-line)' }}
        >
          <span className="shrink-0 text-[12px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            拆分视图
          </span>
          <select
            className="max-w-[200px] flex-1 rounded border bg-transparent px-1.5 py-0.5 text-[11.5px] outline-none"
            style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
            value={targetId}
            onChange={(e) => setSplitWfId(e.target.value)}
            title="选择右侧分栏显示的工作流"
          >
            {ids.map((id) => (
              <option key={id} value={id} className="bg-[var(--sm-bg)]">
                {workflows[id]?.name ?? id}
                {id === activeWfId ? '（主）' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1">
          {ids.length <= 1 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
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
  ): Promise<void> => {
    const current = useWorkflowStore.getState();
    const run = current.workerRuns.find((item) => item.runId === runId);
    if (!run) return;
    const proposals = await Promise.all(
      Object.values(run.tasks)
        .filter((task) => task.worktreePath)
        .map((task) => buildWorkerCleanupProposal({
          run,
          task,
          acceptance: task.acceptanceId ? session.getAcceptance(task.acceptanceId) : undefined,
          isWorktreeTracked: (path) => session.manager.isTracked(path),
          computeWorktreeSignature: (path) => session.computeWorktreeSignature(path),
        })),
    );
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
  ): Promise<void> => {
    for (const run of runs) {
      for (const task of Object.values(run.tasks)) {
        if (task.cleanupStatus === 'cleaned') continue;
        if (!task.worktreeId || !task.worktreePath || !task.branch || !task.baseRevision) continue;
        const restored = await session.manager.restore({
          id: task.worktreeId,
          path: task.worktreePath,
          branch: task.branch,
          baseRevision: task.baseRevision,
          createdAt: task.updatedAt,
          status: 'created',
        });
        if (!restored) {
          useWorkflowStore.getState().addLog(
            'warn',
            `Worker worktree 未能从 git 恢复登记：${task.taskId}`,
          );
        }
      }
    }
  };

  const auditLoadedWorkerRunFacts = async (projectPath: string | null): Promise<void> => {
    if (!isTauri || !projectPath) return;
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
        now: new Date().toISOString(),
      });
      const parsed = bootstrapped.stream;
      const current = useWorkflowStore.getState();
      if (!current.projectId || current.projectPath !== projectPath) return;
      let report: WorkerRunConsistencyReport;
      let controlReport: ReturnType<typeof auditProjectControlConsistency> | null = null;
      if (parsed.status === 'needs-repair') {
        const projection: DomainProjection = { lastSequence: 0, runs: {}, tasks: {} };
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
          projectId: current.projectId,
          runs: current.workerRuns,
          events: parsed.events,
        });
        controlReport = auditProjectControlConsistency({
          projectId: current.projectId,
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
      const runtime = installWorkerRunRuntime({
        projectId: current.projectId,
        taskGraphs: current.projectControl.taskGraphs ?? [],
        runs: current.workerRuns,
        consistency: report,
      });
      current.setWorkerRunRecoveries(runtime.recoveries);
      if (current.workerRuns.length > 0) {
        current.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(current.orchestrations, current.workerRuns),
        );
      }
      if (!report.ok) {
        current.addLog(
          'warn',
          `Worker 事实源审计未通过：${report.issues.map((item) => item.message).join('；')}`,
        );
      }
      if (controlReport && !controlReport.ok) {
        current.addLog(
          'warn',
          `ProjectControl 事实审计未通过：${controlReport.issues.map((item) => item.message).join('；')}`,
        );
      }
    } catch (cause) {
      useWorkflowStore.getState().addLog(
        'warn',
        `Worker 事件流无法审计：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const runQueuedWorker = async (runId: string): Promise<void> => {
    if (!isTauri) throw new Error('Worker 自动执行需要桌面端项目环境');
    const beforeSave = useWorkflowStore.getState();
    const projectId = beforeSave.projectId;
    const projectPath = beforeSave.projectPath;
    if (!projectId || !projectPath) throw new Error('项目必须先保存，Worker 才能创建隔离 worktree');

    // queued 状态和 RunCreated/TaskQueued 事实先落盘；进程若在 Codex 启动前退出，重开仍能恢复该 Run。
    await beforeSave.saveProject();
    const session = await ensureGuiDevSession(projectPath);
    if (!session) throw new Error('开发宿主不可用，Worker 未启动');
    const current = useWorkflowStore.getState();
    if (current.projectId !== projectId) throw new Error('项目在 Worker 启动前发生切换');
    const [{ createTauriEventStoreAdapter }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
      import('./domain/tauriEventStore'),
      import('./domain/sideEffects'),
      import('./projectControl/workerSideEffects'),
    ]);
    const sideEffectRepository = new sideEffectsModule.SideEffectJournalRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );
    const sideEffects = workerSideEffectsModule.createWorkerSideEffectRecorder(sideEffectRepository);
    const eventRepository = new EventStreamRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );

    const coordinator = createGuiProjectWorkerRunCoordinator({
      projectId,
      projectPath,
      runs: current.workerRuns,
      session,
      concurrency: current.maxConcurrency,
      sideEffects,
      assertConsistency: async () => {
        const parsed = await eventRepository.readStream();
        if (parsed.status === 'needs-repair') {
          throw new Error(
            `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
          );
        }
        const current = useWorkflowStore.getState();
        const report = auditWorkerRunConsistency({
          projectId,
          runs: current.workerRuns,
          events: parsed.events,
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
        const latest = useWorkflowStore.getState();
        if (latest.projectId !== projectId) throw new Error('Worker 执行期间项目发生切换');
        recordProjectEvents(projectId, events);
        const nextRuns = latest.workerRuns.map((run) => run.runId === state.runId ? state : run);
        latest.setWorkerRuns(nextRuns);
        latest.setOrchestrations(
          projectWorkerRunsOntoOrchestrations(latest.orchestrations, nextRuns),
        );
        latest.setWorkerRunEvidence(mergeWorkerEvidence(latest.workerRunEvidence, session.collector.records));
        const effectRecords = await loadWorkerSideEffects(sideEffectRepository);
        latest.setWorkerRunSideEffects(mergeWorkerSideEffects(latest.workerRunSideEffects, effectRecords));
        await latest.saveProject();
      },
    });
    await coordinator.run(runId);
    await refreshWorkerCleanupProposals(session, runId);
  };

  const recoverInterruptedWorkerEffects = async (
    projectPath: string | null,
    runIds: string[],
  ): Promise<void> => {
    if (!isTauri || !projectPath || runIds.length === 0) return;
    try {
      const [{ createTauriEventStoreAdapter }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
        import('./domain/tauriEventStore'),
        import('./domain/sideEffects'),
        import('./projectControl/workerSideEffects'),
      ]);
      const recorder = workerSideEffectsModule.createWorkerSideEffectRecorder(
        new sideEffectsModule.SideEffectJournalRepository(
          createTauriEventStoreAdapter(projectPath),
          projectPath,
        ),
      );
      for (const runId of runIds) await recorder.recoverInterruptedRun(runId);
    } catch (cause) {
      // Recovery is fail-closed: keep the visible recovery record when the journal cannot be read/repaired.
      useWorkflowStore.getState().addLog(
        'warn',
        `Worker 副作用账本无法完成恢复核对：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const loadProjectWorkerEvidence = async (projectPath: string | null): Promise<void> => {
    if (!isTauri || !projectPath) return;
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
      const records = await loadWorkerEvidence(persistence);
      const effects = await loadWorkerSideEffects(sideEffectRepository);
      const current = useWorkflowStore.getState();
      if (current.projectPath === projectPath) {
        current.setWorkerRunEvidence(mergeWorkerEvidence(current.workerRunEvidence, records));
        current.setWorkerRunSideEffects(mergeWorkerSideEffects(current.workerRunSideEffects, effects));
      }
    } catch (cause) {
      useWorkflowStore.getState().addLog(
        'warn',
        `Worker Evidence 无法加载：${cause instanceof Error ? cause.message : String(cause)}`,
      );
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

    const [{ createTauriEventStoreAdapter }, sideEffectsModule, workerSideEffectsModule] = await Promise.all([
      import('./domain/tauriEventStore'),
      import('./domain/sideEffects'),
      import('./projectControl/workerSideEffects'),
    ]);
    const recorder = workerSideEffectsModule.createWorkerSideEffectRecorder(
      new sideEffectsModule.SideEffectJournalRepository(
        createTauriEventStoreAdapter(projectPath),
        projectPath,
      ),
    );
    const journal = await recorder.recoverInterruptedRun(runId);
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
    await current.saveProject();
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
    const session = await ensureGuiDevSession(projectPath);
    if (!session) throw new Error('开发宿主不可用，Worker cleanup 未执行');

    if (action === 'approve') {
      approveWorkerCleanupProposal(proposal, session);
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
    const cleanupResult = await executeWorkerCleanupWithReceipt({
      proposal,
      repository,
      host: session,
      now: new Date().toISOString(),
    });
    current.setWorkerRunSideEffects(
      mergeWorkerSideEffects(current.workerRunSideEffects, [cleanupResult.sideEffect]),
    );
    if (!cleanupResult.cleaned) {
      await current.saveProject();
      throw new Error('宿主 cleanup 未完成，副作用已标记为 unknown，需要人工核对');
    }

    const run = current.workerRuns.find((item) => item.runId === runId);
    if (!run) throw new Error(`找不到 Worker Run：${runId}`);
    const cleaned = markWorkerTaskCleaned({
      state: run,
      taskId,
      receiptId: cleanupResult.sideEffect.receipt?.receiptId ?? '',
      decisionId: globalThis.crypto?.randomUUID?.() ?? `cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      now: new Date().toISOString(),
    });
    recordProjectEvents(projectId, cleaned.events);
    const nextRuns = current.workerRuns.map((item) => item.runId === runId ? cleaned.state : item);
    current.setWorkerRuns(nextRuns);
    current.setOrchestrations(
      projectWorkerRunsOntoOrchestrations(current.orchestrations, nextRuns),
    );
    await current.saveProject();
    await refreshWorkerCleanupProposals(session, runId);
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
        const fs = await import('@tauri-apps/plugin-fs');
        const ok = await fs.exists(sess.path);
        if (!ok || cancelled) return;
        const { openProjectByPath } = await import('./io/projectIO');
        const file = await openProjectByPath(sess.path);
        if (!file || cancelled) return;
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
    // Phase 1（H4 GUI）：项目切换时先清 Rust 登记态再卸载旧 DevSession，
    // 打开时先同步宿主再初始化（audit P1：dev_init_session 成功后才注册 dev 节点）
    let lastRecoveryKey = '';
    let lastEvidencePath: string | null = null;
    const scheduleRecovery = (state: ReturnType<typeof useWorkflowStore.getState>): void => {
      if (!state.projectId) {
        lastRecoveryKey = '';
        return;
      }
      const runIds = state.workerRunRecoveries.map((item) => item.runId);
      const key = `${state.projectId}:${runIds.join(',')}`;
      if (key === lastRecoveryKey) return;
      lastRecoveryKey = key;
      void recoverInterruptedWorkerEffects(state.projectPath, runIds);
    };
    const scheduleEvidence = (state: ReturnType<typeof useWorkflowStore.getState>): void => {
      if (!state.projectId || !state.projectPath) {
        lastEvidencePath = null;
        return;
      }
      if (state.projectPath === lastEvidencePath) return;
      lastEvidencePath = state.projectPath;
      void loadProjectWorkerEvidence(state.projectPath);
    };
    let sessionTransition: Promise<void> = Promise.resolve();
    const reloadProjectCustomNodes = (state: {
      projectId: string | null;
      projectPath: string | null;
    }): void => {
      terminatePluginRuntime();
      unloadProjectCustomNodes();
      if (state.projectId) {
        void scanProjectCustomNodes({
          projectId: state.projectId,
          projectPath: state.projectPath,
        }).catch(() => {});
      }
    };
    let projectLifecycle: ReturnType<typeof createProjectPluginLifecycleScheduler>;
    projectLifecycle = createProjectPluginLifecycleScheduler(({ previous, next, epoch }) => {
      reloadProjectCustomNodes(next);
      sessionTransition = sessionTransition
        .catch(() => {})
        .then(async () => {
          if (previous?.projectId) await teardownGuiDevSession();
          if (!projectLifecycle.isCurrent(epoch, next) || !next.projectId) return;
          const session = await ensureGuiDevSession(next.projectPath);
          if (!projectLifecycle.isCurrent(epoch, next)) return;
          if (session) void restoreWorkerWorktrees(session, useWorkflowStore.getState().workerRuns);
          await auditLoadedWorkerRunFacts(next.projectPath);
        });
    });
    const initialState = useWorkflowStore.getState();
    projectLifecycle.observe({
      projectId: initialState.projectId,
      projectPath: initialState.projectPath,
    });
    scheduleRecovery(initialState);
    scheduleEvidence(initialState);
    const unsubscribe = useWorkflowStore.subscribe((s) => {
      // 有项目则进入主界面；无项目（含关闭项目）则回到欢迎页
      setShowWelcome(!s.projectId);
      projectLifecycle.observe({ projectId: s.projectId, projectPath: s.projectPath });
      scheduleRecovery(s);
      scheduleEvidence(s);
    });
    return () => {
      projectLifecycle.dispose();
      unsubscribe();
    };
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
        className={`flex h-screen flex-col font-app ${workspaceMode === 'advanced' ? 'sm-pro-shell' : 'sm-simple-root'}`}
        style={{ background: 'var(--sm-bg)', color: 'var(--sm-ink)' }}
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
                    className="sm-pro-resize-handle sm-pro-resize-handle-x w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
                    style={{ background: 'var(--sm-line)' }}
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
                  className="sm-pro-resize-handle sm-pro-resize-handle-x w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
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
                  className="sm-pro-resize-handle sm-pro-resize-handle-y h-1 shrink-0 cursor-row-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
                  onPointerDown={startResize('y', 'bottom', shortcutsH)}
                  title="拖动调节快捷键面板高度"
                />
                <div className="sm-panel shrink-0" style={{ color: 'var(--sm-ink-soft)' }}>
                  <div className="sm-panel-tabs">
                    <button className="sm-panel-tab" data-active={true}>
                      <Keyboard size={12} /> 快捷键
                    </button>
                    <div className="flex flex-1 items-center justify-end">
                      <button
                        className="flex cursor-pointer items-center gap-1 border-l px-3 text-[11px] transition-colors hover:text-ink"
                        style={{ color: 'var(--sm-ink-faint)', borderColor: 'var(--sm-line)' }}
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
                  className="sm-pro-resize-handle sm-pro-resize-handle-y h-1 shrink-0 cursor-row-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
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
            className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center"
            style={{
              background: 'color-mix(in srgb, var(--sm-bg) 70%, transparent)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <div
              className="rounded-lg border-2 border-dashed px-10 py-8 text-center text-[15px] font-semibold"
              style={{ borderColor: 'var(--sm-accent)', color: 'var(--sm-accent)' }}
            >
              松开以打开工作流文件 (.workflow.json)
            </div>
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
}
