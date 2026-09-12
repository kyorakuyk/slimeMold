import type {
  TaskGraphProjection,
  TaskGraphProjectionNode,
} from './taskGraphProjection';

export type ProgressSummaryScope = 'task' | 'project';
export type ProgressSummaryStatus =
  | 'not-started'
  | 'in-progress'
  | 'review'
  | 'blocked'
  | 'partial'
  | 'completed'
  | 'cancelled'
  | 'unknown';
export type CompletionBasis =
  | 'not-started'
  | 'in-progress'
  | 'review'
  | 'blocked'
  | 'partial'
  | 'evidence-backed'
  | 'unverified'
  | 'inconsistent';

export interface ChildTaskSummary {
  total: number;
  completed: number;
  blocked: number;
  active: number;
  notStarted: number;
  cancelled: number;
}

export interface ChangedFilesSummary {
  known: boolean;
  count: number;
}

export interface ProgressSummary {
  summaryId: string;
  subjectId: string;
  scope: ProgressSummaryScope;
  sourceVersion: number;
  status: ProgressSummaryStatus;
  completionBasis: CompletionBasis;
  consistency: 'consistent' | 'inconsistent';
  evidenceRefs: readonly string[];
  acceptanceRefs: readonly string[];
  decisionRefs: readonly string[];
  changedFilesSummary: ChangedFilesSummary;
  childTaskSummary: ChildTaskSummary;
  blockers: readonly string[];
  ambiguities: readonly string[];
  decisionNeeded: boolean;
  lastUpdated: string;
  staleAt: string;
}

export type TaskProgressCapsule = ProgressSummary;
export type ManagerBrief = ProgressSummary;

export interface BuildProgressSummaryInput {
  projection: TaskGraphProjection;
  summaryId: string;
  sourceVersion: number;
  now: string;
  staleAt: string;
}

export interface BuildTaskProgressCapsuleInput extends BuildProgressSummaryInput {
  taskId: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function requiredPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是大于 0 的安全整数`);
  return value;
}

function statusOf(node: TaskGraphProjectionNode): ProgressSummaryStatus {
  if (node.consistency !== 'consistent') return 'unknown';
  switch (node.projectedStatus) {
    case 'proposed':
    case 'approved':
    case 'queued':
      return 'not-started';
    case 'in_progress':
      return 'in-progress';
    case 'review':
      return 'review';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function childTaskSummary(nodes: readonly TaskGraphProjectionNode[]): ChildTaskSummary {
  return nodes.reduce<ChildTaskSummary>((summary, node) => {
    const status = statusOf(node);
    summary.total += 1;
    if (status === 'completed') summary.completed += 1;
    else if (status === 'blocked') summary.blocked += 1;
    else if (status === 'in-progress' || status === 'review') summary.active += 1;
    else if (status === 'cancelled') summary.cancelled += 1;
    else if (status === 'not-started') summary.notStarted += 1;
    return summary;
  }, {
    total: 0,
    completed: 0,
    blocked: 0,
    active: 0,
    notStarted: 0,
    cancelled: 0,
  });
}

function uniqueRefs(nodes: readonly TaskGraphProjectionNode[], field: 'evidenceIds' | 'acceptanceId'): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const values = field === 'evidenceIds'
      ? node.evidenceIds
      : (node.acceptanceId ? [node.acceptanceId] : []);
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        refs.push(value);
      }
    }
  }
  return refs;
}

function aggregateStatus(
  nodes: readonly TaskGraphProjectionNode[],
  counts: ChildTaskSummary,
): { status: ProgressSummaryStatus; completionBasis: CompletionBasis } {
  if (nodes.some((node) => node.consistency !== 'consistent')) {
    return { status: 'unknown', completionBasis: 'inconsistent' };
  }
  if (counts.total === 0) return { status: 'not-started', completionBasis: 'not-started' };
  if (counts.completed === counts.total) {
    const evidenceBacked = nodes.every((node) => (
      statusOf(node) === 'completed'
      && node.evidenceIds.length > 0
      && node.acceptanceId !== undefined
    ));
    return {
      status: 'completed',
      completionBasis: evidenceBacked ? 'evidence-backed' : 'unverified',
    };
  }
  if (counts.blocked > 0) {
    const hasOtherWork = counts.completed > 0 || counts.active > 0 || counts.notStarted > 0;
    return {
      status: hasOtherWork ? 'partial' : 'blocked',
      completionBasis: hasOtherWork ? 'partial' : 'blocked',
    };
  }
  if (counts.active > 0) return { status: 'in-progress', completionBasis: 'in-progress' };
  if (counts.cancelled === counts.total) return { status: 'cancelled', completionBasis: 'unverified' };
  return { status: 'not-started', completionBasis: 'not-started' };
}

function buildSummary(
  nodes: readonly TaskGraphProjectionNode[],
  input: BuildProgressSummaryInput,
  scope: ProgressSummaryScope,
  subjectId: string,
): ProgressSummary {
  const summaryId = requiredText(input.summaryId, 'summary id');
  const now = requiredText(input.now, 'summary 更新时间');
  const staleAt = requiredText(input.staleAt, 'summary staleAt');
  const sourceVersion = requiredPositiveInteger(input.sourceVersion, 'summary sourceVersion');
  const counts = childTaskSummary(nodes);
  const aggregate = aggregateStatus(nodes, counts);
  const blockers = nodes
    .filter((node) => node.projectedStatus === 'blocked')
    .map((node) => node.taskId);
  const ambiguities = nodes
    .filter((node) => node.consistency !== 'consistent' || node.error)
    .map((node) => node.error ?? `${node.taskId}: ${node.consistency}`);

  return {
    summaryId,
    subjectId: requiredText(subjectId, 'summary subjectId'),
    scope,
    sourceVersion,
    status: aggregate.status,
    completionBasis: aggregate.completionBasis,
    consistency: nodes.every((node) => node.consistency === 'consistent')
      ? 'consistent'
      : 'inconsistent',
    evidenceRefs: uniqueRefs(nodes, 'evidenceIds'),
    acceptanceRefs: uniqueRefs(nodes, 'acceptanceId'),
    decisionRefs: [],
    changedFilesSummary: { known: false, count: 0 },
    childTaskSummary: counts,
    blockers,
    ambiguities,
    decisionNeeded: blockers.length > 0 || ambiguities.length > 0,
    lastUpdated: now,
    staleAt,
  };
}

export function buildTaskProgressCapsule(
  input: BuildTaskProgressCapsuleInput,
): TaskProgressCapsule {
  const taskId = requiredText(input.taskId, 'task id');
  const node = input.projection.nodes.find((candidate) => candidate.taskId === taskId);
  if (!node) throw new Error(`Task 不存在于 projection：${taskId}`);
  return buildSummary([node], input, 'task', taskId);
}

export function buildManagerBrief(input: BuildProgressSummaryInput): ManagerBrief {
  return buildSummary(input.projection.nodes, input, 'project', input.projection.graphId);
}
