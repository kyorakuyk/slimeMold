export const PROJECT_AGENT_ROLES = [
  'master-ceo',
  'project-delivery-architect',
  'department-head',
  'module-lead',
  'worker',
  'specialist',
  'independent-reviewer',
  'evidence-knowledge-steward',
  'integration-release-manager',
  'security-risk-reviewer',
  'operations-recovery-manager',
] as const;

export type ProjectAgentRole = typeof PROJECT_AGENT_ROLES[number];

export type ProjectRoleLayer = 'command' | 'planning' | 'delivery' | 'execution' | 'assurance';

export type ProjectDataClass =
  | 'project-summary'
  | 'decision'
  | 'task'
  | 'evidence'
  | 'source-file'
  | 'raw-transcript'
  | 'runtime'
  | 'credential';

export type ProjectTool =
  | 'read-project'
  | 'read-evidence'
  | 'read-file'
  | 'write-worktree'
  | 'run-tests'
  | 'request-feedback'
  | 'delegate-child'
  | 'approve-plan'
  | 'merge'
  | 'release'
  | 'cleanup';

export interface ProjectRoleDefinition {
  layer: ProjectRoleLayer;
  summaryKind: 'global' | 'project-plan' | 'department' | 'module' | 'task' | 'evidence' | 'review' | 'recovery';
  canDelegateTo: readonly ProjectAgentRole[];
}

export const PROJECT_ROLE_DEFINITIONS = {
  'master-ceo': {
    layer: 'command',
    summaryKind: 'global',
    canDelegateTo: ['project-delivery-architect'],
  },
  'project-delivery-architect': {
    layer: 'planning',
    summaryKind: 'project-plan',
    canDelegateTo: ['department-head'],
  },
  'department-head': {
    layer: 'delivery',
    summaryKind: 'department',
    canDelegateTo: ['module-lead'],
  },
  'module-lead': {
    layer: 'delivery',
    summaryKind: 'module',
    canDelegateTo: ['worker', 'specialist'],
  },
  worker: {
    layer: 'execution',
    summaryKind: 'task',
    canDelegateTo: ['specialist'],
  },
  specialist: {
    layer: 'execution',
    summaryKind: 'evidence',
    canDelegateTo: [],
  },
  'independent-reviewer': {
    layer: 'assurance',
    summaryKind: 'review',
    canDelegateTo: [],
  },
  'evidence-knowledge-steward': {
    layer: 'assurance',
    summaryKind: 'evidence',
    canDelegateTo: [],
  },
  'integration-release-manager': {
    layer: 'assurance',
    summaryKind: 'review',
    canDelegateTo: [],
  },
  'security-risk-reviewer': {
    layer: 'assurance',
    summaryKind: 'review',
    canDelegateTo: [],
  },
  'operations-recovery-manager': {
    layer: 'assurance',
    summaryKind: 'recovery',
    canDelegateTo: [],
  },
} as const satisfies Record<ProjectAgentRole, ProjectRoleDefinition>;

export function canDelegateProjectRole(
  parentRole: ProjectAgentRole,
  childRole: ProjectAgentRole,
): boolean {
  const allowedRoles: readonly ProjectAgentRole[] = PROJECT_ROLE_DEFINITIONS[parentRole].canDelegateTo;
  return allowedRoles.includes(childRole);
}

export interface AgentScope {
  allowedFiles: readonly string[];
  allowedDataClasses: readonly ProjectDataClass[];
  allowedTools: readonly ProjectTool[];
  allowedAgentRoles: readonly ProjectAgentRole[];
  maxDelegationDepth: number;
  maxFanOut: number;
  maxTokens: number;
  maxCalls: number;
  maxMoneyCents: number;
  maxDurationMs: number;
  expiresAt: string;
}

export type ChildScope = AgentScope;

function assertCanonicalString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} 必须是非空 canonical 字符串`);
  }
}

function assertAllowlist(scope: AgentScope, field: keyof Pick<AgentScope, 'allowedFiles' | 'allowedDataClasses' | 'allowedTools' | 'allowedAgentRoles'>): void {
  const values = scope[field];
  if (!Array.isArray(values)) throw new Error(`${field} 必须是数组`);
  values.forEach((value, index) => assertCanonicalString(value, `${field}[${index}]`));
}

function assertNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} 必须是非负安全整数`);
  }
}

function assertScope(scope: AgentScope, label: string): void {
  assertAllowlist(scope, 'allowedFiles');
  assertAllowlist(scope, 'allowedDataClasses');
  assertAllowlist(scope, 'allowedTools');
  assertAllowlist(scope, 'allowedAgentRoles');
  assertNonNegativeSafeInteger(scope.maxDelegationDepth, `${label}.maxDelegationDepth`);
  assertNonNegativeSafeInteger(scope.maxFanOut, `${label}.maxFanOut`);
  assertNonNegativeSafeInteger(scope.maxTokens, `${label}.maxTokens`);
  assertNonNegativeSafeInteger(scope.maxCalls, `${label}.maxCalls`);
  assertNonNegativeSafeInteger(scope.maxMoneyCents, `${label}.maxMoneyCents`);
  assertNonNegativeSafeInteger(scope.maxDurationMs, `${label}.maxDurationMs`);
  assertCanonicalString(scope.expiresAt, `${label}.expiresAt`);
  if (Number.isNaN(Date.parse(scope.expiresAt))) {
    throw new Error(`${label}.expiresAt 必须是有效时间`);
  }
}

export function validateAgentScope(value: unknown, label = 'scope'): AgentScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const scope = value as AgentScope;
  assertScope(scope, label);
  return {
    allowedFiles: [...scope.allowedFiles],
    allowedDataClasses: [...scope.allowedDataClasses],
    allowedTools: [...scope.allowedTools],
    allowedAgentRoles: [...scope.allowedAgentRoles],
    maxDelegationDepth: scope.maxDelegationDepth,
    maxFanOut: scope.maxFanOut,
    maxTokens: scope.maxTokens,
    maxCalls: scope.maxCalls,
    maxMoneyCents: scope.maxMoneyCents,
    maxDurationMs: scope.maxDurationMs,
    expiresAt: scope.expiresAt,
  };
}

function intersectAllowlist<T extends string>(
  parent: readonly T[],
  policy: readonly T[],
  child: readonly T[],
): T[] {
  const policySet = new Set(policy);
  const childSet = new Set(child);
  return parent.filter((value) => policySet.has(value) && childSet.has(value));
}

function earliestExpiry(...scopes: readonly AgentScope[]): string {
  return scopes
    .map((scope) => scope.expiresAt)
    .reduce((earliest, candidate) => (
      Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest
    ));
}

/**
 * Derives ChildScope = ParentScope ∩ PolicyScope ∩ ChildTaskScope.
 * Empty intersections are intentional denials, not reasons to widen access.
 */
export function intersectChildScope(
  parent: AgentScope,
  policy: AgentScope,
  childTask: AgentScope,
): ChildScope {
  const safeParent = validateAgentScope(parent, 'parent');
  const safePolicy = validateAgentScope(policy, 'policy');
  const safeChildTask = validateAgentScope(childTask, 'childTask');

  return {
    allowedFiles: intersectAllowlist(safeParent.allowedFiles, safePolicy.allowedFiles, safeChildTask.allowedFiles),
    allowedDataClasses: intersectAllowlist(safeParent.allowedDataClasses, safePolicy.allowedDataClasses, safeChildTask.allowedDataClasses),
    allowedTools: intersectAllowlist(safeParent.allowedTools, safePolicy.allowedTools, safeChildTask.allowedTools),
    allowedAgentRoles: intersectAllowlist(safeParent.allowedAgentRoles, safePolicy.allowedAgentRoles, safeChildTask.allowedAgentRoles),
    maxDelegationDepth: Math.min(safeParent.maxDelegationDepth, safePolicy.maxDelegationDepth, safeChildTask.maxDelegationDepth),
    maxFanOut: Math.min(safeParent.maxFanOut, safePolicy.maxFanOut, safeChildTask.maxFanOut),
    maxTokens: Math.min(safeParent.maxTokens, safePolicy.maxTokens, safeChildTask.maxTokens),
    maxCalls: Math.min(safeParent.maxCalls, safePolicy.maxCalls, safeChildTask.maxCalls),
    maxMoneyCents: Math.min(safeParent.maxMoneyCents, safePolicy.maxMoneyCents, safeChildTask.maxMoneyCents),
    maxDurationMs: Math.min(safeParent.maxDurationMs, safePolicy.maxDurationMs, safeChildTask.maxDurationMs),
    expiresAt: earliestExpiry(safeParent, safePolicy, safeChildTask),
  };
}
