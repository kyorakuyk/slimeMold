import {
  canDelegateProjectRole,
  intersectChildScope,
  PROJECT_ROLE_DEFINITIONS,
  validateAgentScope,
  type AgentScope,
  type ProjectAgentRole,
} from './hierarchy';

export type AgentPerformative = 'request' | 'propose' | 'accept' | 'reject' | 'report' | 'event';

export type AgentReferenceKind =
  | 'decision'
  | 'plan'
  | 'task'
  | 'evidence'
  | 'acceptance'
  | 'receipt'
  | 'feedback'
  | 'artifact';

export interface AgentIdentity {
  projectId: string;
  agentId: string;
  role: ProjectAgentRole;
  taskId?: string;
}

export interface AgentReference {
  projectId: string;
  kind: AgentReferenceKind;
  id: string;
  version: number;
}

export type UncertaintyLevel = 'none' | 'low' | 'medium' | 'high';

export interface MessageUncertainty {
  level: UncertaintyLevel;
  reasons: readonly string[];
}

export interface AgentMessageEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  messageId: string;
  traceId: string;
  sender: AgentIdentity;
  recipient: AgentIdentity;
  performative: AgentPerformative;
  schema: string;
  schemaVersion: number;
  payload: TPayload;
  references: readonly AgentReference[];
  preconditions: readonly string[];
  expectedEffects: readonly string[];
  uncertainty: MessageUncertainty;
  expiry: string | null;
  idempotencyKey: string;
}

export interface ContextPack {
  schemaVersion: 1;
  projectId: string;
  taskId: string;
  taskExecutionId: string;
  attemptId: string;
  contextVersion: number;
  goal: string;
  nonGoals: readonly string[];
  decisionRefs: readonly AgentReference[];
  evidenceRefs: readonly AgentReference[];
  requiredFiles: readonly string[];
  requiredDocuments: readonly AgentReference[];
  dependencyRefs: readonly AgentReference[];
  acceptanceCriteria: readonly string[];
  scope: AgentScope;
  sourceVersion: number;
}

export interface AgentBudget {
  maxTokens: number;
  maxCalls: number;
  maxMoneyCents: number;
  maxDurationMs: number;
}

export interface DelegationRequest {
  schemaVersion: 1;
  delegationId: string;
  delegationDepth: number;
  idempotencyKey: string;
  projectId: string;
  parentTaskId: string;
  childTaskId: string;
  rootTaskId: string;
  parentRole: ProjectAgentRole;
  requestedRole: ProjectAgentRole;
  purpose: string;
  effectiveScope: AgentScope;
  allowedEvidenceRefs: readonly AgentReference[];
  maxDepth: number;
  maxFanout: number;
  budget: AgentBudget;
  deadline: string;
  expiresAt: string;
  expectedOutputs: readonly string[];
}

export interface CreateDelegationRequestInput {
  delegationId: string;
  delegationDepth: number;
  idempotencyKey: string;
  projectId: string;
  parentTaskId: string;
  childTaskId: string;
  rootTaskId: string;
  parentRole: ProjectAgentRole;
  requestedRole: ProjectAgentRole;
  purpose: string;
  parentScope: AgentScope;
  policyScope: AgentScope;
  childTaskScope: AgentScope;
  allowedEvidenceRefs: readonly AgentReference[];
  deadline: string;
  expectedOutputs: readonly string[];
}

export interface FeedbackOption {
  id: string;
  label: string;
}

export interface FeedbackRequest {
  schemaVersion: 1;
  feedbackId: string;
  projectId: string;
  taskId: string;
  parentTaskId: string;
  attemptId: string;
  contextVersion: number;
  ambiguity: string;
  affectedScope: readonly string[];
  affectedAcceptance: readonly AgentReference[];
  options: readonly FeedbackOption[];
  recommendation?: string;
  blocking: boolean;
  requestedBy: AgentIdentity;
  sourceRefs: readonly AgentReference[];
  expiresAt: string;
}

export interface CreateFeedbackRequestInput {
  feedbackId: string;
  projectId: string;
  taskId: string;
  parentTaskId: string;
  attemptId: string;
  contextVersion: number;
  ambiguity: string;
  affectedScope: readonly string[];
  affectedAcceptance: readonly AgentReference[];
  options: readonly FeedbackOption[];
  recommendation?: string;
  blocking: boolean;
  requestedBy: AgentIdentity;
  sourceRefs: readonly AgentReference[];
  expiresAt: string;
}

const PERFORMATIVES: readonly AgentPerformative[] = [
  'request',
  'propose',
  'accept',
  'reject',
  'report',
  'event',
];

const REFERENCE_KINDS: readonly AgentReferenceKind[] = [
  'decision',
  'plan',
  'task',
  'evidence',
  'acceptance',
  'receipt',
  'feedback',
  'artifact',
];

const UNCERTAINTY_LEVELS: readonly UncertaintyLevel[] = ['none', 'low', 'medium', 'high'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象`);
  return value;
}

function requiredCanonicalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} 必须是非空 canonical 字符串`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} 必须是大于 0 的安全整数`);
  }
  return value as number;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  return value.map((item, index) => requiredCanonicalString(item, `${field}[${index}]`));
}

function isProjectAgentRole(value: unknown): value is ProjectAgentRole {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(PROJECT_ROLE_DEFINITIONS, value);
}

function parseIdentity(value: unknown, field: string): AgentIdentity {
  const record = requiredRecord(value, field);
  const projectId = requiredCanonicalString(record.projectId, `${field}.projectId`);
  const agentId = requiredCanonicalString(record.agentId, `${field}.agentId`);
  if (!isProjectAgentRole(record.role)) throw new Error(`${field}.role 不是有效的项目 Agent 角色`);

  let taskId: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'taskId')) {
    taskId = requiredCanonicalString(record.taskId, `${field}.taskId`);
  }

  return {
    projectId,
    agentId,
    role: record.role,
    ...(taskId ? { taskId } : {}),
  };
}

function parseReferences(value: unknown, projectId: string, field = 'references'): AgentReference[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  return value.map((item, index) => {
    const record = requiredRecord(item, `${field}[${index}]`);
    const referenceProjectId = requiredCanonicalString(
      record.projectId,
      `${field}[${index}].projectId`,
    );
    if (referenceProjectId !== projectId) {
      throw new Error(`${field}[${index}] 不属于当前 project`);
    }
    if (!REFERENCE_KINDS.includes(record.kind as AgentReferenceKind)) {
      throw new Error(`${field}[${index}].kind 不是有效引用类型`);
    }
    return {
      projectId: referenceProjectId,
      kind: record.kind as AgentReferenceKind,
      id: requiredCanonicalString(record.id, `${field}[${index}].id`),
      version: requiredSafeInteger(record.version, `${field}[${index}].version`),
    };
  });
}

function parseUncertainty(value: unknown): MessageUncertainty {
  const record = requiredRecord(value, 'uncertainty');
  if (!UNCERTAINTY_LEVELS.includes(record.level as UncertaintyLevel)) {
    throw new Error('uncertainty.level 不是有效等级');
  }
  return {
    level: record.level as UncertaintyLevel,
    reasons: stringArray(record.reasons, 'uncertainty.reasons'),
  };
}

function parseExpiry(value: unknown): string | null {
  if (value === null) return null;
  const expiry = requiredCanonicalString(value, 'expiry');
  if (Number.isNaN(Date.parse(expiry))) throw new Error('expiry 必须是有效时间');
  return expiry;
}

/**
 * Validates and copies the stable outer Agent message contract.
 * The schema-specific payload is intentionally left to its own validator.
 */
export function parseAgentMessageEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
): AgentMessageEnvelope<TPayload> {
  const record = requiredRecord(value, 'message');
  const messageId = requiredCanonicalString(record.messageId, 'messageId');
  const traceId = requiredCanonicalString(record.traceId, 'traceId');
  const sender = parseIdentity(record.sender, 'sender');
  const recipient = parseIdentity(record.recipient, 'recipient');
  if (sender.projectId !== recipient.projectId) {
    throw new Error('sender 和 recipient 必须属于同一 project');
  }
  if (!PERFORMATIVES.includes(record.performative as AgentPerformative)) {
    throw new Error('performative 不是有效消息语义');
  }
  const schema = requiredCanonicalString(record.schema, 'schema');
  const schemaVersion = requiredSafeInteger(record.schemaVersion, 'schemaVersion');
  const payload = requiredRecord(record.payload, 'payload') as TPayload;
  const references = parseReferences(record.references, sender.projectId);
  const preconditions = stringArray(record.preconditions, 'preconditions');
  const expectedEffects = stringArray(record.expectedEffects, 'expectedEffects');
  const uncertainty = parseUncertainty(record.uncertainty);
  const expiry = parseExpiry(record.expiry);
  const idempotencyKey = requiredCanonicalString(record.idempotencyKey, 'idempotencyKey');

  return {
    messageId,
    traceId,
    sender,
    recipient,
    performative: record.performative as AgentPerformative,
    schema,
    schemaVersion,
    payload,
    references,
    preconditions,
    expectedEffects,
    uncertainty,
    expiry,
    idempotencyKey,
  };
}

function requiredSchemaVersion(value: unknown, field: string): 1 {
  const version = requiredSafeInteger(value, field);
  if (version !== 1) throw new Error(`${field} 只支持 v1`);
  return 1;
}

function requiredDate(value: unknown, field: string): string {
  const date = requiredCanonicalString(value, field);
  if (Number.isNaN(Date.parse(date))) throw new Error(`${field} 必须是有效时间`);
  return date;
}

function requiredProjectRole(value: unknown, field: string): ProjectAgentRole {
  if (!isProjectAgentRole(value)) throw new Error(`${field} 不是有效的项目 Agent 角色`);
  return value;
}

function assertReferenceKinds(
  references: readonly AgentReference[],
  kinds: readonly AgentReferenceKind[],
  field: string,
): void {
  references.forEach((reference, index) => {
    if (!kinds.includes(reference.kind)) {
      throw new Error(`${field}[${index}] 的 kind 不符合协议`);
    }
  });
}

function assertFilesInScope(
  files: readonly string[],
  scope: AgentScope,
  field: string,
): void {
  files.forEach((file, index) => {
    if (!scope.allowedFiles.includes(file)) {
      throw new Error(`${field}[${index}] 超出 scope`);
    }
  });
}

function parseFeedbackOptions(value: unknown): FeedbackOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('options 必须至少包含一个选项');
  }
  return value.map((item, index) => {
    const record = requiredRecord(item, `options[${index}]`);
    return {
      id: requiredCanonicalString(record.id, `options[${index}].id`),
      label: requiredCanonicalString(record.label, `options[${index}].label`),
    };
  });
}

export function createContextPack(input: ContextPack): ContextPack {
  const record = requiredRecord(input, 'contextPack');
  const schemaVersion = requiredSchemaVersion(record.schemaVersion, 'contextPack.schemaVersion');
  const projectId = requiredCanonicalString(record.projectId, 'contextPack.projectId');
  const taskId = requiredCanonicalString(record.taskId, 'contextPack.taskId');
  const taskExecutionId = requiredCanonicalString(record.taskExecutionId, 'contextPack.taskExecutionId');
  const attemptId = requiredCanonicalString(record.attemptId, 'contextPack.attemptId');
  const contextVersion = requiredSafeInteger(record.contextVersion, 'contextPack.contextVersion');
  const goal = requiredCanonicalString(record.goal, 'contextPack.goal');
  const nonGoals = stringArray(record.nonGoals, 'contextPack.nonGoals');
  const decisionRefs = parseReferences(record.decisionRefs, projectId, 'contextPack.decisionRefs');
  const evidenceRefs = parseReferences(record.evidenceRefs, projectId, 'contextPack.evidenceRefs');
  const requiredFiles = stringArray(record.requiredFiles, 'contextPack.requiredFiles');
  const requiredDocuments = parseReferences(
    record.requiredDocuments,
    projectId,
    'contextPack.requiredDocuments',
  );
  const dependencyRefs = parseReferences(record.dependencyRefs, projectId, 'contextPack.dependencyRefs');
  const acceptanceCriteria = stringArray(record.acceptanceCriteria, 'contextPack.acceptanceCriteria');
  const scope = validateAgentScope(record.scope, 'contextPack.scope');
  const sourceVersion = requiredSafeInteger(record.sourceVersion, 'contextPack.sourceVersion');

  assertReferenceKinds(decisionRefs, ['decision'], 'contextPack.decisionRefs');
  assertReferenceKinds(evidenceRefs, ['evidence'], 'contextPack.evidenceRefs');
  assertReferenceKinds(requiredDocuments, ['artifact'], 'contextPack.requiredDocuments');
  assertReferenceKinds(dependencyRefs, ['task', 'plan'], 'contextPack.dependencyRefs');
  assertFilesInScope(requiredFiles, scope, 'contextPack.requiredFiles');
  if (evidenceRefs.length > 0 && !scope.allowedDataClasses.includes('evidence')) {
    throw new Error('contextPack.scope 未允许 evidence 数据');
  }

  return {
    schemaVersion,
    projectId,
    taskId,
    taskExecutionId,
    attemptId,
    contextVersion,
    goal,
    nonGoals,
    decisionRefs,
    evidenceRefs,
    requiredFiles,
    requiredDocuments,
    dependencyRefs,
    acceptanceCriteria,
    scope,
    sourceVersion,
  };
}

export function createDelegationRequest(input: CreateDelegationRequestInput): DelegationRequest {
  const delegationId = requiredCanonicalString(input.delegationId, 'delegationId');
  const delegationDepth = requiredSafeInteger(input.delegationDepth, 'delegationDepth');
  const idempotencyKey = requiredCanonicalString(input.idempotencyKey, 'idempotencyKey');
  const projectId = requiredCanonicalString(input.projectId, 'projectId');
  const parentTaskId = requiredCanonicalString(input.parentTaskId, 'parentTaskId');
  const childTaskId = requiredCanonicalString(input.childTaskId, 'childTaskId');
  const rootTaskId = requiredCanonicalString(input.rootTaskId, 'rootTaskId');
  if (parentTaskId === childTaskId) throw new Error('parentTaskId 与 childTaskId 不能相同');
  const parentRole = requiredProjectRole(input.parentRole, 'parentRole');
  const requestedRole = requiredProjectRole(input.requestedRole, 'requestedRole');
  if (!canDelegateProjectRole(parentRole, requestedRole)) {
    throw new Error(`角色 ${parentRole} 不能直接下发 ${requestedRole}`);
  }
  const purpose = requiredCanonicalString(input.purpose, 'purpose');
  const effectiveScope = intersectChildScope(
    input.parentScope,
    input.policyScope,
    input.childTaskScope,
  );
  if (!effectiveScope.allowedAgentRoles.includes(requestedRole)) {
    throw new Error(`requestedRole 不在 effective scope 中：${requestedRole}`);
  }
  if (!effectiveScope.allowedTools.includes('delegate-child')) {
    throw new Error('effective scope 未允许 delegate-child');
  }
  if (delegationDepth > effectiveScope.maxDelegationDepth) {
    throw new Error(`delegationDepth 超出 scope：${delegationDepth}`);
  }
  const allowedEvidenceRefs = parseReferences(
    input.allowedEvidenceRefs,
    projectId,
    'allowedEvidenceRefs',
  );
  assertReferenceKinds(allowedEvidenceRefs, ['evidence'], 'allowedEvidenceRefs');
  const deadline = requiredDate(input.deadline, 'deadline');
  const expiresAt = effectiveScope.expiresAt;
  if (Date.parse(deadline) > Date.parse(expiresAt)) {
    throw new Error('deadline 不能晚于 effective scope expiry');
  }
  const expectedOutputs = stringArray(input.expectedOutputs, 'expectedOutputs');

  return {
    schemaVersion: 1,
    delegationId,
    delegationDepth,
    idempotencyKey,
    projectId,
    parentTaskId,
    childTaskId,
    rootTaskId,
    parentRole,
    requestedRole,
    purpose,
    effectiveScope,
    allowedEvidenceRefs,
    maxDepth: effectiveScope.maxDelegationDepth,
    maxFanout: effectiveScope.maxFanOut,
    budget: {
      maxTokens: effectiveScope.maxTokens,
      maxCalls: effectiveScope.maxCalls,
      maxMoneyCents: effectiveScope.maxMoneyCents,
      maxDurationMs: effectiveScope.maxDurationMs,
    },
    deadline,
    expiresAt,
    expectedOutputs,
  };
}

export function createFeedbackRequest(input: CreateFeedbackRequestInput): FeedbackRequest {
  const feedbackId = requiredCanonicalString(input.feedbackId, 'feedbackId');
  const projectId = requiredCanonicalString(input.projectId, 'projectId');
  const taskId = requiredCanonicalString(input.taskId, 'taskId');
  const parentTaskId = requiredCanonicalString(input.parentTaskId, 'parentTaskId');
  const attemptId = requiredCanonicalString(input.attemptId, 'attemptId');
  const contextVersion = requiredSafeInteger(input.contextVersion, 'contextVersion');
  const ambiguity = requiredCanonicalString(input.ambiguity, 'ambiguity');
  const affectedScope = stringArray(input.affectedScope, 'affectedScope');
  const affectedAcceptance = parseReferences(
    input.affectedAcceptance,
    projectId,
    'affectedAcceptance',
  );
  assertReferenceKinds(affectedAcceptance, ['acceptance'], 'affectedAcceptance');
  const options = parseFeedbackOptions(input.options);
  const recommendation = input.recommendation === undefined
    ? undefined
    : requiredCanonicalString(input.recommendation, 'recommendation');
  if (typeof input.blocking !== 'boolean') throw new Error('blocking 必须是布尔值');
  const requestedBy = parseIdentity(input.requestedBy, 'requestedBy');
  if (requestedBy.projectId !== projectId) throw new Error('requestedBy 不属于当前 project');
  const sourceRefs = parseReferences(input.sourceRefs, projectId, 'sourceRefs');
  const expiresAt = requiredDate(input.expiresAt, 'expiresAt');

  return {
    schemaVersion: 1,
    feedbackId,
    projectId,
    taskId,
    parentTaskId,
    attemptId,
    contextVersion,
    ambiguity,
    affectedScope,
    affectedAcceptance,
    options,
    ...(recommendation ? { recommendation } : {}),
    blocking: input.blocking,
    requestedBy,
    sourceRefs,
    expiresAt,
  };
}
