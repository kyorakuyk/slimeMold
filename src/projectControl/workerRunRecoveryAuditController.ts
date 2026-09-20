import type { AcceptanceRecord } from '../dev/session';
import type { EvidenceRecord } from '../dev/evidence';
import type { EventStreamRepository } from '../domain/eventStore';
import type { DomainProjection, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types';
import type { ProjectControlSnapshot } from './types';
import type { WorkerCleanupProposal } from './workerCleanup';
import type { WorkerRunRecovery } from './workerRunRuntime';

export type WorkerRunAuditEventRepository = EventStreamRepository;
export type WorkerRunAuditBaseline = typeof import('./eventSourceBootstrap')['ensureProjectControlEventBaseline'];
export type WorkerRunAuditReconcile = typeof import('./workerRunRehydration')['reconcileWorkerRunsFromEvents'];
export type WorkerRunAuditRehydrate = typeof import('./workerRunRehydration')['rehydrateWorkerRunsFromEvents'];
export type WorkerRunAuditWorkerFacts = typeof import('./workerRunConsistency')['auditWorkerRunConsistency'];
export type WorkerRunAuditControlFacts = typeof import('./projectControlConsistency')['auditProjectControlConsistency'];
export type WorkerRunAuditRuntime = typeof import('./workerRunRuntime')['installWorkerRunRuntime'];
export type WorkerRunAuditProjection = typeof import('./workerRunOrchestrationProjection')['projectWorkerRunsOntoOrchestrations'];
export type WorkerRunAuditSuppression = typeof import('./workerRunOrchestrationProjection')['suppressInvalidWorkerRunProjection'];

export interface WorkerRunRecoveryAuditState {
  projectId: string | null;
  projectPath: string | null;
  projectControl: ProjectControlSnapshot;
  workerRuns: readonly WorkerRunQueueState[];
  orchestrations: readonly Orchestration[];
  workerRunEvidence: readonly EvidenceRecord[];
  workerRunSideEffects: readonly SideEffectRecord[];
}

export interface WorkerRunRecoveryAuditDeps {
  isTauri: boolean;
  getState: () => WorkerRunRecoveryAuditState;
  setWorkerRuns: (runs: WorkerRunQueueState[]) => void;
  setOrchestrations: (orchestrations: Orchestration[]) => void;
  setWorkerRunRecoveries: (recoveries: WorkerRunRecovery[]) => void;
  setWorkerCleanupProposals: (proposals: WorkerCleanupProposal[]) => void;
  addLog: (level: 'warn', message: string) => void;
  saveProject: (projectId: string, projectPath: string, signal?: AbortSignal) => Promise<unknown>;
  createEventRepository: (projectPath: string) => Promise<WorkerRunAuditEventRepository>;
  ensureEventBaseline: WorkerRunAuditBaseline;
  reconcileWorkerRunsFromEvents: WorkerRunAuditReconcile;
  rehydrateWorkerRunsFromEvents: WorkerRunAuditRehydrate;
  auditWorkerRunConsistency: WorkerRunAuditWorkerFacts;
  auditProjectControlConsistency: WorkerRunAuditControlFacts;
  installWorkerRunRuntime: WorkerRunAuditRuntime;
  projectWorkerRunsOntoOrchestrations: WorkerRunAuditProjection;
  suppressInvalidWorkerRunProjection: WorkerRunAuditSuppression;
  now: () => string;
}

export interface WorkerRunRecoveryAuditController {
  auditLoadedWorkerRunFacts: (
    projectPath: string | null,
    acceptances?: readonly AcceptanceRecord[],
    signal?: AbortSignal,
  ) => Promise<void>;
}

export function createWorkerRunRecoveryAuditController(
  deps: WorkerRunRecoveryAuditDeps,
): WorkerRunRecoveryAuditController {
  const auditLoadedWorkerRunFacts = async (
    projectPath: string | null,
    acceptances?: readonly AcceptanceRecord[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!deps.isTauri || !projectPath || signal?.aborted) return;
    try {
      const repository = await deps.createEventRepository(projectPath);
      const before = deps.getState();
      if (!before.projectId || before.projectPath !== projectPath) return;
      const bootstrapped = await deps.ensureEventBaseline({
        repository,
        projectId: before.projectId,
        snapshot: before.projectControl,
        workerRuns: before.workerRuns,
        now: deps.now(),
      });
      if (signal?.aborted) return;
      const parsed = bootstrapped.stream;
      let current = deps.getState();
      if (!current.projectId || current.projectPath !== projectPath) return;
      const projectId = current.projectId;
      const reconciledSnapshots = deps.reconcileWorkerRunsFromEvents({
        projectId,
        events: parsed.events,
        runs: current.workerRuns,
        taskGraphs: current.projectControl.taskGraphs ?? [],
      });
      if (reconciledSnapshots.issues.length > 0) {
        deps.addLog(
          'warn',
          `Worker retry snapshot reconciliation 发现问题：${reconciledSnapshots.issues.map((item) => item.message).join('；')}`,
        );
      }
      if (reconciledSnapshots.changedRunIds.length > 0 && reconciledSnapshots.issues.length === 0) {
        deps.setWorkerRuns(reconciledSnapshots.runs);
        deps.setOrchestrations(
          deps.projectWorkerRunsOntoOrchestrations(current.orchestrations, reconciledSnapshots.runs),
        );
        await deps.saveProject(projectId, projectPath, signal);
        if (signal?.aborted) return;
        current = deps.getState();
      }
      const rehydrated = current.workerRuns.length === 0
        ? deps.rehydrateWorkerRunsFromEvents({
          projectId,
          events: parsed.events,
          taskGraphs: current.projectControl.taskGraphs ?? [],
          existingRuns: current.workerRuns,
        })
        : { runs: [], issues: [] };
      if (rehydrated.issues.length > 0) {
        deps.addLog(
          'warn',
          `Worker Run 投影恢复被阻止：${rehydrated.issues.map((item) => item.message).join('；')}`,
        );
      } else if (rehydrated.runs.length > 0) {
        if (signal?.aborted) return;
        deps.setWorkerRuns(rehydrated.runs);
        deps.setOrchestrations(
          deps.projectWorkerRunsOntoOrchestrations(current.orchestrations, rehydrated.runs),
        );
        await deps.saveProject(projectId, projectPath, signal);
        if (signal?.aborted) return;
        current = deps.getState();
      }
      let report: ReturnType<WorkerRunAuditWorkerFacts>;
      let controlReport: ReturnType<WorkerRunAuditControlFacts> | null = null;
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
        report = deps.auditWorkerRunConsistency({
          projectId,
          runs: current.workerRuns,
          events: parsed.events,
          evidence: current.workerRunEvidence,
          acceptances,
          sideEffects: current.workerRunSideEffects,
          taskGraphs: current.projectControl.taskGraphs ?? [],
        });
        controlReport = deps.auditProjectControlConsistency({
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
      const runtime = deps.installWorkerRunRuntime({
        projectId,
        taskGraphs: current.projectControl.taskGraphs ?? [],
        runs: current.workerRuns,
        consistency: report,
      });
      deps.setWorkerRunRecoveries(runtime.recoveries);
      const controlOk = controlReport === null || controlReport.ok;
      const hasWorkerProjection = current.workerRuns.length > 0
        || current.orchestrations.some((orchestration) => (
          orchestration.runIds.length > 0
          || Object.keys(orchestration.stageLogsByRun ?? {}).length > 0
        ));
      if (report.ok && controlOk && current.workerRuns.length > 0) {
        deps.setOrchestrations(
          deps.projectWorkerRunsOntoOrchestrations(current.orchestrations, current.workerRuns),
        );
      } else if (!report.ok || !controlOk || (hasWorkerProjection && current.workerRuns.length === 0)) {
        const reason = report.issues[0]?.message
          ?? controlReport?.issues[0]?.message
          ?? (current.workerRuns.length === 0 ? 'Worker Run registry empty during audit' : 'Worker facts audit failed');
        deps.setOrchestrations(
          deps.suppressInvalidWorkerRunProjection(current.orchestrations, `Worker facts invalid：${reason}`),
        );
      }
      if (!report.ok) {
        deps.setWorkerCleanupProposals([]);
        deps.addLog(
          'warn',
          `Worker 事实源审计未通过：${report.issues.map((item) => item.message).join('；')}`,
        );
      }
      if (controlReport && !controlReport.ok) {
        deps.setWorkerCleanupProposals([]);
        deps.addLog(
          'warn',
          `ProjectControl 事实审计未通过：${controlReport.issues.map((item) => item.message).join('；')}`,
        );
      }
    } catch (cause) {
      if (signal?.aborted) return;
      const failedState = deps.getState();
      const message = `Worker 事件流无法审计：${cause instanceof Error ? cause.message : String(cause)}`;
      deps.setWorkerRunRecoveries(failedState.workerRuns.map((run): WorkerRunRecovery => ({
        runId: run.runId,
        projectId: run.projectId,
        reason: 'event-stream-invalid',
        message,
      })));
      deps.setWorkerCleanupProposals([]);
      deps.setOrchestrations(
        deps.suppressInvalidWorkerRunProjection(failedState.orchestrations, `Worker facts invalid：${message}`),
      );
      deps.addLog('warn', message);
    }
  };

  return { auditLoadedWorkerRunFacts };
}
