export type ExecutionObjective = 'cost-first' | 'quality-first' | 'speed-first' | 'balanced';
export type SandboxMode = 'workspace-write' | 'danger-full-access';
export type WorkerKind = 'planner' | 'worker';
export type DomainActor = 'user' | 'master' | 'runtime' | 'system' | `plugin:${string}`;

export interface DomainEvent<TPayload = unknown> {
  eventId: string;
  streamId: string;
  sequence: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: number;
  payload: TPayload;
  actor: DomainActor;
  occurredAt: string;
  causationId?: string;
  correlationId?: string;
  source?: {
    objectId: string;
    objectVersion: number;
  };
  sensitivity?: 'normal' | 'private';
  synthetic?: boolean;
}

export type TaskProjectionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export type RunProjectionStatus = 'queued' | 'running' | 'partial' | 'blocked' | 'failed' | 'cancelled' | 'succeeded';

export interface DomainProjection {
  lastSequence: number;
  runs: Record<string, { status: RunProjectionStatus }>;
  tasks: Record<string, { status: TaskProjectionStatus; runId?: string }>;
}

/**
 * Append-only stream invariant for the Phase 0a in-memory contract.
 * The file writer and lock live in a later adapter; this function remains pure.
 */
export function appendDomainEvent(
  events: readonly DomainEvent[],
  event: DomainEvent,
): DomainEvent[] {
  const duplicate = events.find((item) => item.eventId === event.eventId);
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
      throw new Error(`事件 id 已存在但内容不同：${event.eventId}`);
    }
    return events as DomainEvent[];
  }

  const expectedSequence = (events.at(-1)?.sequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(`事件 sequence 不连续：期望 ${expectedSequence}，实际 ${event.sequence}`);
  }

  const previousAggregate = [...events]
    .reverse()
    .find(
      (item) =>
        item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId,
    );
  const expectedAggregateVersion = (previousAggregate?.aggregateVersion ?? 0) + 1;
  if (event.aggregateVersion !== expectedAggregateVersion) {
    throw new Error(
      `聚合版本不连续：期望 ${expectedAggregateVersion}，实际 ${event.aggregateVersion}`,
    );
  }

  return [...events, event];
}

/** Replay only the stable projection fields needed by Phase 0a. */
export function replayDomainEvents(events: readonly DomainEvent[]): DomainProjection {
  const projection: DomainProjection = {
    lastSequence: 0,
    runs: {},
    tasks: {},
  };

  for (const event of events) {
    if (event.sequence !== projection.lastSequence + 1) {
      throw new Error(`事件流存在缺口：期望 ${projection.lastSequence + 1}，实际 ${event.sequence}`);
    }

    const payload = event.payload as Record<string, unknown>;
    switch (event.eventType) {
      case 'RunCreated':
        projection.runs[event.aggregateId] = { status: 'queued' };
        break;
      case 'RunStarted':
        projection.runs[event.aggregateId] = { status: 'running' };
        break;
      case 'RunPartial':
        projection.runs[event.aggregateId] = { status: 'partial' };
        break;
      case 'RunBlocked':
        projection.runs[event.aggregateId] = { status: 'blocked' };
        break;
      case 'RunFailed':
        projection.runs[event.aggregateId] = { status: 'failed' };
        break;
      case 'RunCancelled':
        projection.runs[event.aggregateId] = { status: 'cancelled' };
        break;
      case 'RunSucceeded':
        projection.runs[event.aggregateId] = { status: 'succeeded' };
        break;
      case 'TaskQueued':
        projection.tasks[event.aggregateId] = {
          status: 'queued',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      case 'TaskStarted':
        projection.tasks[event.aggregateId] = {
          status: 'running',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      case 'TaskSucceeded':
        projection.tasks[event.aggregateId] = {
          status: 'succeeded',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      case 'TaskFailed':
        projection.tasks[event.aggregateId] = {
          status: 'failed',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      case 'TaskBlocked':
        projection.tasks[event.aggregateId] = {
          status: 'blocked',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      case 'TaskCancelled':
        projection.tasks[event.aggregateId] = {
          status: 'cancelled',
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
        };
        break;
      default:
        // Unknown events remain part of the stream; this projection simply ignores them.
        break;
    }
    projection.lastSequence = event.sequence;
  }

  return projection;
}

export interface GlobalExecutionPreferences {
  sandboxMode: SandboxMode;
  objective: ExecutionObjective;
  autoPush: boolean;
  managerMerge: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface ProjectExecutionPolicyOverride {
  projectId: string;
  sandboxMode?: SandboxMode;
  objective?: ExecutionObjective;
  autoPush?: boolean;
  managerMerge?: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface RunExecutionPolicyOverride {
  sandboxMode?: SandboxMode;
  objective?: ExecutionObjective;
  autoPush?: boolean;
  managerMerge?: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface EffectiveExecutionPolicy {
  projectId: string;
  sandboxMode: SandboxMode;
  objective: ExecutionObjective;
  autoPush: boolean;
  managerMerge: boolean;
  riskAcceptedAt?: string;
  riskAcceptedBy?: string;
}

export interface ResolvedExecutionPolicy {
  policy: EffectiveExecutionPolicy;
  sources: {
    sandboxMode: 'global' | 'project' | 'run';
    objective: 'global' | 'project' | 'run';
    autoPush: 'global' | 'project' | 'run';
    managerMerge: 'global' | 'project' | 'run';
  };
  requiresRiskAcceptance: boolean;
}

export function resolveExecutionPolicy(
  global: GlobalExecutionPreferences,
  project: ProjectExecutionPolicyOverride,
  run: RunExecutionPolicyOverride = {},
): ResolvedExecutionPolicy {
  const sourceOf = <K extends keyof RunExecutionPolicyOverride>(key: K): 'global' | 'project' | 'run' => {
    if (run[key] !== undefined) return 'run';
    if (project[key] !== undefined) return 'project';
    return 'global';
  };
  const sandboxSource = sourceOf('sandboxMode');
  const objectiveSource = sourceOf('objective');
  const autoPushSource = sourceOf('autoPush');
  const managerMergeSource = sourceOf('managerMerge');
  const sandboxMode = run.sandboxMode ?? project.sandboxMode ?? global.sandboxMode;
  const riskAcceptedAt =
    sandboxSource === 'run'
      ? run.riskAcceptedAt
      : sandboxSource === 'project'
        ? project.riskAcceptedAt
        : global.riskAcceptedAt;
  const riskAcceptedBy =
    sandboxSource === 'run'
      ? run.riskAcceptedBy
      : sandboxSource === 'project'
        ? project.riskAcceptedBy
        : global.riskAcceptedBy;

  return {
    policy: {
      projectId: project.projectId,
      sandboxMode,
      objective: run.objective ?? project.objective ?? global.objective,
      autoPush: run.autoPush ?? project.autoPush ?? global.autoPush,
      managerMerge: run.managerMerge ?? project.managerMerge ?? global.managerMerge,
      riskAcceptedAt,
      riskAcceptedBy,
    },
    sources: {
      sandboxMode: sandboxSource,
      objective: objectiveSource,
      autoPush: autoPushSource,
      managerMerge: managerMergeSource,
    },
    requiresRiskAcceptance: sandboxMode === 'danger-full-access' && !riskAcceptedAt,
  };
}

export interface ApprovalFingerprint {
  planHash: string;
  policyHash: string;
  baseRevision: string;
  worktreePath: string;
  targetRef: string;
  capabilities: readonly string[];
}

export interface ApprovalGrant extends ApprovalFingerprint {
  id: string;
  approvedBy: string;
  approvedAt: string;
  status: 'active' | 'revoked';
}

export function createApprovalGrant(
  input: Omit<ApprovalGrant, 'status'>,
): ApprovalGrant {
  return { ...input, status: 'active' };
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join('\u0000') === [...new Set(right)].sort().join('\u0000');
}

export function validateApprovalGrant(
  grant: ApprovalGrant,
  current: ApprovalFingerprint,
): { ok: true } | { ok: false; reason: string } {
  if (grant.status !== 'active') return { ok: false, reason: '批准授权已撤销' };
  if (grant.planHash !== current.planHash) return { ok: false, reason: '计划 hash 已变化' };
  if (grant.policyHash !== current.policyHash) return { ok: false, reason: '策略 hash 已变化' };
  if (grant.baseRevision !== current.baseRevision) return { ok: false, reason: '基线 revision 已变化' };
  if (grant.worktreePath !== current.worktreePath) return { ok: false, reason: 'worktree 已变化' };
  if (grant.targetRef !== current.targetRef) return { ok: false, reason: '目标 ref 已变化' };
  if (!sameCapabilities(grant.capabilities, current.capabilities)) {
    return { ok: false, reason: '允许的 capability 已变化' };
  }
  return { ok: true };
}

export function approvePlanAndEnqueueRun(input: {
  grant: ApprovalGrant;
  current: ApprovalFingerprint;
  streamId: string;
  runId: string;
  sequence: number;
  projectVersion: number;
  now: string;
}): DomainEvent[] {
  const validation = validateApprovalGrant(input.grant, input.current);
  if (!validation.ok) throw new Error(`不能批准计划：${validation.reason}`);

  return [
    {
      eventId: `${input.grant.id}:approved`,
      streamId: input.streamId,
      sequence: input.sequence,
      aggregateType: 'Project',
      aggregateId: input.streamId,
      aggregateVersion: input.projectVersion + 1,
      eventType: 'PlanApproved',
      schemaVersion: 1,
      payload: {
        grantId: input.grant.id,
        planHash: input.grant.planHash,
        policyHash: input.grant.policyHash,
      },
      actor: 'user',
      occurredAt: input.now,
    },
    {
      eventId: `${input.grant.id}:run:${input.runId}`,
      streamId: input.streamId,
      sequence: input.sequence + 1,
      aggregateType: 'Run',
      aggregateId: input.runId,
      aggregateVersion: 1,
      eventType: 'RunCreated',
      schemaVersion: 1,
      payload: {
        grantId: input.grant.id,
        runId: input.runId,
      },
      actor: 'runtime',
      occurredAt: input.now,
      causationId: input.grant.id,
    },
  ];
}

export interface WorkerCapabilityRequest {
  kind: WorkerKind;
  projectRoot: string;
  worktreePath: string;
  sandboxMode: SandboxMode;
  canWrite: boolean;
  tools: readonly string[];
}

export function validateWorkerCapability(
  request: WorkerCapabilityRequest,
): { ok: true } | { ok: false; reason: string } {
  const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (!request.projectRoot.trim() || !request.worktreePath.trim()) {
    return { ok: false, reason: 'projectRoot 和 worktreePath 不能为空' };
  }

  if (request.kind === 'planner') {
    if (request.canWrite) return { ok: false, reason: 'Planner 不允许写入' };
    if (request.tools.some((tool) => /write|patch|delete|push|merge/i.test(tool))) {
      return { ok: false, reason: 'Planner 不允许写入或外部副作用工具' };
    }
    return { ok: true };
  }

  if (!request.canWrite) return { ok: false, reason: 'Worker 必须声明写入能力' };
  if (normalizePath(request.projectRoot) === normalizePath(request.worktreePath)) {
    return { ok: false, reason: 'Worker 不能直接写项目根目录' };
  }
  if (request.sandboxMode !== 'workspace-write' && request.sandboxMode !== 'danger-full-access') {
    return { ok: false, reason: 'Worker sandbox 模式无效' };
  }
  return { ok: true };
}

export type SideEffectStatus = 'planned' | 'started' | 'receipt' | 'unknown';
export type SideEffectRecovery = 'retry' | 'skip' | 'needs-user';

export interface SideEffectReceipt {
  receiptId: string;
  observedAt: string;
  outputHash?: string;
}

export interface SideEffectRecord {
  idempotencyKey: string;
  kind: string;
  target: string;
  inputHash: string;
  status: SideEffectStatus;
  recovery: SideEffectRecovery;
  receipt?: SideEffectReceipt;
  unknownReason?: string;
}

export function createSideEffect(input: Omit<SideEffectRecord, 'status' | 'recovery' | 'receipt' | 'unknownReason'>): SideEffectRecord {
  return { ...input, status: 'planned', recovery: 'retry' };
}

export function startSideEffect(record: SideEffectRecord): SideEffectRecord {
  if (record.status !== 'planned') throw new Error('只有 planned 副作用可以启动');
  return { ...record, status: 'started', recovery: 'retry' };
}

export function completeSideEffect(record: SideEffectRecord, receipt: SideEffectReceipt): SideEffectRecord {
  if (record.status !== 'started') throw new Error('只有 started 副作用可以完成');
  return { ...record, status: 'receipt', recovery: 'skip', receipt, unknownReason: undefined };
}

export function markSideEffectUnknown(record: SideEffectRecord, reason: string): SideEffectRecord {
  if (record.status !== 'started') throw new Error('只有 started 副作用可以标记 unknown');
  return { ...record, status: 'unknown', recovery: 'needs-user', unknownReason: reason, receipt: undefined };
}
