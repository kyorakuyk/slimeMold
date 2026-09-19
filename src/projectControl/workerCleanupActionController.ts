import { ensureGuiDevSession as defaultEnsureGuiDevSession } from '../dev/gui';
import { saveProjectFile } from '../io/projectIO';
import { buildProjectFile } from '../store/workflowSerialize';
import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ProjectControlSnapshot } from './types';
import type { WorkerCleanupProposal } from './workerCleanup';
import type { WorkerRunRecovery } from './workerRunRuntime';
import type { ProjectOperation } from './projectLifecycleController';
import { getRestoredWorkerRunForCleanup } from './workerRunRuntime';
import {
  approveWorkerCleanupProposal,
} from './workerCleanup';
import { executeWorkerCleanupWithReceipt } from './workerCleanupExecution';
import { markWorkerTaskCleaned } from './workerCleanupCommand';
import { mergeWorkerSideEffects } from './workerEvidence';
import { projectWorkerRunsOntoOrchestrations } from './workerRunOrchestrationProjection';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { EventStreamRepository } from '../domain/eventStore';
import { flushPendingProjectEvents } from './eventBuffer';
import type { Orchestration } from '../types';

// Keep the save input contract aligned with the existing ProjectFile serializer.
type ProjectBuildState = Parameters<typeof buildProjectFile>[0];
type GuiProjectSession = NonNullable<Awaited<ReturnType<typeof defaultEnsureGuiDevSession>>>;

type ProjectSave = () => Promise<unknown>;

export interface WorkerCleanupActionState extends ProjectBuildState {
  projectId: string | null;
  projectPath: string | null;
  projectControl: ProjectControlSnapshot;
  workerRuns: WorkerRunQueueState[];
  workerRunSideEffects: SideEffectRecord[];
  workerRunRecoveries: WorkerRunRecovery[];
  workerCleanupProposals: WorkerCleanupProposal[];
  orchestrations: Orchestration[];
  setWorkerRunSideEffects: (effects: SideEffectRecord[]) => void;
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  setOrchestrations: (orchestrations: Orchestration[]) => void;
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
  setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => void;
  saveProject: ProjectSave;
}

export interface WorkerCleanupActionControllerDeps {
  getState: () => WorkerCleanupActionState;
  getProjectOperation: (projectId: string | null, projectPath: string | null) => ProjectOperation;
  assertProjectOperation: (operation: ProjectOperation) => void;
  recordProjectEvents: (projectId: string, events: DomainEvent[]) => void;
  refreshWorkerCleanupProposals: (
    session: GuiProjectSession,
    runId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  isTauri: boolean;
  ensureGuiDevSession?: typeof defaultEnsureGuiDevSession;
}

export function createWorkerCleanupActionController(
  deps: WorkerCleanupActionControllerDeps,
): {
  cleanupWorkerRun: (
    runId: string,
    taskId: string,
    action: 'approve' | 'cleanup',
  ) => Promise<void>;
} {
  const ensureGuiDevSession = deps.ensureGuiDevSession ?? defaultEnsureGuiDevSession;

  const cleanupWorkerRun = async (
    runId: string,
    taskId: string,
    action: 'approve' | 'cleanup',
  ): Promise<void> => {
    if (!deps.isTauri) throw new Error('Worker cleanup 需要桌面端项目环境');
    const current = deps.getState();
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
    const operation = deps.getProjectOperation(projectId, projectPath);
    deps.assertProjectOperation(operation);
    const session = await ensureGuiDevSession(projectPath, operation.controller.signal);
    if (!session) throw new Error('开发宿主不可用，Worker cleanup 未执行');
    deps.assertProjectOperation(operation);
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
      const latest = deps.getState();
      const sameProject = latest.projectId === projectId && latest.projectPath === projectPath;
      if (sameProject) {
        // Receipt 已经 durable 后，不再把当前 operation 的 cancellation 当作阻断条件。
        await latest.saveProject();
      } else {
        const [{ createTauriEventStoreAdapter }] = await Promise.all([
          import('../domain/tauriEventStore'),
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
      const { openProjectByPath } = await import('../io/projectIO');
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
      deps.assertProjectOperation(operation);
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
      import('../domain/tauriEventStore'),
      import('../domain/sideEffects'),
    ]);
    const repository = new sideEffectsModule.SideEffectJournalRepository(
      createTauriEventStoreAdapter(projectPath),
      projectPath,
    );
    deps.assertProjectOperation(operation);
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
    const latestAtReceipt = deps.getState();
    const sameProjectAtReceipt = latestAtReceipt.projectId === projectId
      && latestAtReceipt.projectPath === projectPath;
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
    deps.recordProjectEvents(projectId, cleaned.events);
    const nextRuns = current.workerRuns.map((item) => item.runId === runId ? cleaned.state : item);
    if (sameProjectAtReceipt) {
      current.setWorkerRuns(nextRuns);
      current.setOrchestrations(
        projectWorkerRunsOntoOrchestrations(current.orchestrations, nextRuns),
      );
    }
    await persistCleanupState(nextRuns);
    await deps.refreshWorkerCleanupProposals(session, runId, operation.controller.signal);
  };

  return { cleanupWorkerRun };
}
