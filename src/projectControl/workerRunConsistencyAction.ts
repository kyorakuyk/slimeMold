/**
 * workerRunConsistencyAction.ts — pre-execution consistency admission.
 *
 * Event-store I/O, Worker/ProjectControl audit implementations and operation fencing are
 * injected; this module only preserves the assertion/read/audit choreography.
 */
import type { ParsedEventStream } from '../domain/eventStore';
import type { SideEffectRecord } from '../domain/contracts';
import type { AcceptanceRecord } from '../dev/session';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { EvidenceRecord } from '../dev/evidence';
import type { ProjectControlSnapshot } from './types';

export interface WorkerRunConsistencyActionState {
  workerRuns: readonly WorkerRunQueueState[];
  workerRunEvidence: readonly EvidenceRecord[];
  workerRunSideEffects: readonly SideEffectRecord[];
  projectControl: ProjectControlSnapshot;
}

export interface ConsistencyAuditResult {
  ok: boolean;
  issues: ReadonlyArray<{ message: string }>;
}

type WorkerAuditInput = Parameters<typeof import('./workerRunConsistency').auditWorkerRunConsistency>[0];
type ControlAuditInput = Parameters<typeof import('./projectControlConsistency').auditProjectControlConsistency>[0];

export interface WorkerRunConsistencyActionDeps {
  projectId: string;
  getState: () => WorkerRunConsistencyActionState;
  assertOperation: () => void;
  readEventStream: () => Promise<ParsedEventStream>;
  listAcceptances: () => readonly AcceptanceRecord[];
  auditWorkerRunConsistency: (input: WorkerAuditInput) => ConsistencyAuditResult;
  auditProjectControlConsistency: (input: ControlAuditInput) => ConsistencyAuditResult;
}

export async function assertWorkerRunConsistency(
  deps: WorkerRunConsistencyActionDeps,
): Promise<void> {
  deps.assertOperation();
  const parsed = await deps.readEventStream();
  deps.assertOperation();
  if (parsed.status === 'needs-repair') {
    throw new Error(
      `Worker 事件流需要修复：第 ${parsed.corruption?.line ?? '?'} 行 ${parsed.corruption?.reason ?? ''}`,
    );
  }
  const current = deps.getState();
  deps.assertOperation();
  const report = deps.auditWorkerRunConsistency({
    projectId: deps.projectId,
    runs: current.workerRuns,
    events: parsed.events,
    evidence: current.workerRunEvidence,
    acceptances: deps.listAcceptances(),
    sideEffects: current.workerRunSideEffects,
    taskGraphs: current.projectControl.taskGraphs ?? [],
  });
  if (!report.ok) {
    throw new Error(`Worker 事实源不一致：${report.issues.map((item) => item.message).join('；')}`);
  }
  const controlReport = deps.auditProjectControlConsistency({
    projectId: deps.projectId,
    snapshot: current.projectControl,
    events: parsed.events,
  });
  if (!controlReport.ok) {
    throw new Error(`ProjectControl 事实源不一致：${controlReport.issues.map((item) => item.message).join('；')}`);
  }
}
