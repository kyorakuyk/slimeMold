import type { DomainEvent, SideEffectRecord } from '../domain/contracts';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { EvidenceRecord } from '../dev/evidence';
import type { AcceptanceRecord } from '../dev/session';
import type { ProjectTaskGraph } from './types';
import {
  checkInitialConsistencyFacts,
  createWorkerRunAuditContext,
  replayWorkerEvents,
} from './workerRunConsistencyEventChecks';
import { checkOrphanedWorkerEvents } from './workerRunConsistencyOrphanChecks';
import { checkWorkerRunSideEffects } from './workerRunConsistencySideEffectChecks';
import { checkWorkerRun } from './workerRunConsistencyTaskChecks';
import { emptyProjection } from './workerRunConsistencyUtils';
import type {
  WorkerRunConsistencyIssue,
  WorkerRunConsistencyReport,
} from './workerRunConsistencyTypes';

export type {
  WorkerRunConsistencyIssueCode,
  WorkerRunConsistencyIssue,
  WorkerRunConsistencyReport,
} from './workerRunConsistencyTypes';

/**
 * Compare the persisted Worker registry with the durable Worker facts.
 *
 * The event stream is authoritative for audit purposes, but this function does
 * not silently repair either side: any mismatch is returned to the caller so
 * startup/execution can remain fail-closed and surface recovery UI.
 */
export function auditWorkerRunConsistency(input: {
  projectId: string;
  runs: readonly WorkerRunQueueState[];
  events: readonly DomainEvent[];
  evidence?: readonly EvidenceRecord[];
  acceptances?: readonly AcceptanceRecord[];
  sideEffects?: readonly SideEffectRecord[];
  taskGraphs?: readonly ProjectTaskGraph[];
}): WorkerRunConsistencyReport {
  const issues: WorkerRunConsistencyIssue[] = [];
  const projectEvents = checkInitialConsistencyFacts(input, issues);
  const projection = replayWorkerEvents(projectEvents, issues);
  if (!projection) return { ok: false, projection: emptyProjection(), issues };

  const context = createWorkerRunAuditContext(input, projection, issues);
  for (const run of input.runs) checkWorkerRun(context, run);
  checkWorkerRunSideEffects(context);
  checkOrphanedWorkerEvents(context);
  return { ok: issues.length === 0, projection, issues };
}
