/**
 * workerCleanupProposalController.ts — application orchestration for proposal refresh.
 *
 * Canonical TaskGraph restore, proposal lineage, Acceptance binding and host checks remain
 * owned by workerRunRuntime/workerCleanup/DevSession. This module only sequences reads and
 * writes the runtime proposal projection through an injected state port.
 */
import type { SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { ensureGuiDevSession } from '../dev/gui';
import type { ProjectTaskGraph } from './types';
import {
  buildWorkerCleanupProposalSafely,
  type WorkerCleanupProposal,
} from './workerCleanup';
import {
  getRestoredWorkerRunForCleanup,
  type WorkerRunRecovery,
} from './workerRunRuntime';

export type GuiProjectSession = NonNullable<Awaited<ReturnType<typeof ensureGuiDevSession>>>;

export interface WorkerCleanupProposalRefreshState {
  projectId: string | null;
  projectControl: { taskGraphs?: readonly ProjectTaskGraph[] };
  workerRuns: readonly WorkerRunQueueState[];
  workerRunRecoveries: readonly WorkerRunRecovery[];
  workerRunSideEffects: readonly SideEffectRecord[];
  workerCleanupProposals: WorkerCleanupProposal[];
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
  addLog: (level: 'warn', message: string) => void;
}

export interface WorkerCleanupProposalControllerDeps {
  getState: () => WorkerCleanupProposalRefreshState;
}

export interface WorkerCleanupProposalController {
  refresh: (session: GuiProjectSession, runId: string, signal?: AbortSignal) => Promise<void>;
}

export function createWorkerCleanupProposalController(
  deps: WorkerCleanupProposalControllerDeps,
): WorkerCleanupProposalController {
  const refresh = async (
    session: GuiProjectSession,
    runId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (signal?.aborted) return;
    const current = deps.getState();
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
    const latest = deps.getState();
    if (latest.projectId !== run.projectId) return;
    latest.setWorkerCleanupProposals([
      ...latest.workerCleanupProposals.filter((proposal) => proposal.runId !== runId),
      ...proposals,
    ]);
  };

  return { refresh };
}
