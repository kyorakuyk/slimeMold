import { describe, expect, it } from 'vitest';
import {
  createContextPack,
  createDelegationRequest,
  createFeedbackRequest,
  parseAgentMessageEnvelope,
  type AgentMessageEnvelope,
} from './protocol';

const validEnvelope: AgentMessageEnvelope<{ taskId: string }> = {
  messageId: 'message-1',
  traceId: 'trace-1',
  sender: {
    projectId: 'project-1',
    agentId: 'worker-1',
    role: 'worker',
    taskId: 'task-1',
  },
  recipient: {
    projectId: 'project-1',
    agentId: 'lead-1',
    role: 'module-lead',
    taskId: 'task-1',
  },
  performative: 'report',
  schema: 'ProgressCapsule.v1',
  schemaVersion: 1,
  payload: { taskId: 'task-1' },
  references: [{
    projectId: 'project-1',
    kind: 'task',
    id: 'task-1',
    version: 1,
  }],
  preconditions: ['task is running'],
  expectedEffects: ['record progress capsule'],
  uncertainty: {
    level: 'low',
    reasons: [],
  },
  expiry: '2026-09-12T11:00:00.000Z',
  idempotencyKey: 'progress:task-1:attempt-1',
};

describe('parseAgentMessageEnvelope', () => {
  it('accepts a complete project-scoped structured message', () => {
    expect(parseAgentMessageEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it('rejects a message that omits required identity or protocol fields', () => {
    const incomplete = { ...validEnvelope, messageId: '', schema: undefined };

    expect(() => parseAgentMessageEnvelope(incomplete)).toThrow(/messageId|schema/);
  });

  it('rejects a reference from another project', () => {
    const crossProject = {
      ...validEnvelope,
      references: [{ ...validEnvelope.references[0], projectId: 'project-2' }],
    };

    expect(() => parseAgentMessageEnvelope(crossProject)).toThrow(/project/);
  });

  it('rejects invalid schema versions and expiry timestamps', () => {
    expect(() => parseAgentMessageEnvelope({
      ...validEnvelope,
      schemaVersion: 0,
    })).toThrow(/schemaVersion/);
    expect(() => parseAgentMessageEnvelope({
      ...validEnvelope,
      expiry: 'not-a-date',
    })).toThrow(/expiry/);
  });
});

const workerScope = {
  allowedFiles: ['src/app.ts', 'src/core.ts'],
  allowedDataClasses: ['task', 'evidence', 'source-file'] as const,
  allowedTools: ['read-file', 'run-tests', 'request-feedback', 'delegate-child'] as const,
  allowedAgentRoles: ['worker', 'specialist'] as const,
  maxDelegationDepth: 3,
  maxFanOut: 4,
  maxTokens: 5_000,
  maxCalls: 8,
  maxMoneyCents: 100,
  maxDurationMs: 60_000,
  expiresAt: '2026-09-12T12:00:00.000Z',
};

describe('Phase A hierarchical protocol objects', () => {
  it('builds a ContextPack whose files stay inside its effective scope', () => {
    const pack = createContextPack({
      schemaVersion: 1,
      contextPackId: 'context-pack-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskExecutionId: 'execution-1',
      attemptId: 'attempt-1',
      contextVersion: 2,
      goal: '完成受限模块任务',
      nonGoals: ['不修改部署'],
      decisionRefs: [],
      evidenceRefs: [],
      requiredFiles: ['src/app.ts'],
      requiredDocuments: [],
      dependencyRefs: [],
      acceptanceCriteria: ['测试通过'],
      scope: workerScope,
      sourceVersion: 3,
    });

    expect(pack).toMatchObject({
      projectId: 'project-1',
      taskId: 'task-1',
      contextVersion: 2,
      requiredFiles: ['src/app.ts'],
    });
    expect(() => createContextPack({
      ...pack,
      requiredFiles: ['docs/secret.md'],
    })).toThrow(/scope/);
  });

  it('creates a delegation request from the strict effective child scope', () => {
    const request = createDelegationRequest({
      delegationId: 'delegation-1',
      delegationDepth: 1,
      idempotencyKey: 'delegation:task-parent:task-child',
      projectId: 'project-1',
      parentTaskId: 'task-parent',
      childTaskId: 'task-child',
      rootTaskId: 'task-root',
      parentRole: 'module-lead',
      requestedRole: 'worker',
      purpose: '实现一个模块内任务',
      parentScope: workerScope,
      policyScope: { ...workerScope, allowedFiles: ['src/app.ts'], maxTokens: 2_000 },
      childTaskScope: { ...workerScope, allowedFiles: ['src/app.ts'], maxTokens: 1_000 },
      allowedEvidenceRefs: [],
      deadline: '2026-09-12T11:30:00.000Z',
      expectedOutputs: ['代码补丁', '测试 Evidence'],
    });

    expect(request.effectiveScope).toMatchObject({
      allowedFiles: ['src/app.ts'],
      maxTokens: 1_000,
    });
    expect(request.budget).toEqual({
      maxTokens: 1_000,
      maxCalls: 8,
      maxMoneyCents: 100,
      maxDurationMs: 60_000,
    });
    expect(request.maxDepth).toBe(3);
    expect(request.expiresAt).toBe('2026-09-12T12:00:00.000Z');
  });

  it('rejects a delegation that asks for an upward or policy-forbidden role', () => {
    expect(() => createDelegationRequest({
      delegationId: 'delegation-2',
      delegationDepth: 1,
      idempotencyKey: 'delegation:task-parent:task-child:unauthorized',
      projectId: 'project-1',
      parentTaskId: 'task-parent',
      childTaskId: 'task-child',
      rootTaskId: 'task-root',
      parentRole: 'worker',
      requestedRole: 'project-delivery-architect',
      purpose: '越权规划',
      parentScope: workerScope,
      policyScope: workerScope,
      childTaskScope: workerScope,
      allowedEvidenceRefs: [],
      deadline: '2026-09-12T11:30:00.000Z',
      expectedOutputs: ['计划'],
    })).toThrow(/delegate|下发|role|角色/);
  });

  it('creates a blocking FeedbackRequest with task and acceptance provenance', () => {
    const feedback = createFeedbackRequest({
      schemaVersion: 1,
      feedbackId: 'feedback-1',
      projectId: 'project-1',
      taskId: 'task-child',
      parentTaskId: 'task-parent',
      attemptId: 'attempt-1',
      contextVersion: 2,
      ambiguity: '验收是否要求兼容旧格式？',
      affectedScope: ['src/app.ts'],
      affectedAcceptance: [{
        projectId: 'project-1',
        kind: 'acceptance',
        id: 'acceptance-1',
        version: 1,
      }],
      options: [
        { id: 'keep-legacy', label: '保留兼容层' },
        { id: 'drop-legacy', label: '移除兼容层' },
      ],
      recommendation: '先保留兼容层',
      blocking: true,
      requestedBy: validEnvelope.sender,
      sourceRefs: [{
        projectId: 'project-1',
        kind: 'task',
        id: 'task-child',
        version: 1,
      }],
      expiresAt: '2026-09-12T11:00:00.000Z',
    });

    expect(feedback).toMatchObject({
      feedbackId: 'feedback-1',
      blocking: true,
      contextVersion: 2,
      affectedScope: ['src/app.ts'],
    });
    expect(feedback.affectedAcceptance[0].kind).toBe('acceptance');
    expect(() => createFeedbackRequest({
      ...feedback,
      requestedBy: { ...feedback.requestedBy, projectId: 'project-2' },
    })).toThrow(/project/);
  });
});
