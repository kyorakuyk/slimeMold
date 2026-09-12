import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../dev/evidence';
import {
  buildEvidenceIndex,
} from './evidenceIndex';
import { queryEvidenceWithinScope } from './retrieval';
import type { AgentScope } from './hierarchy';

const evidence: EvidenceRecord[] = [{
  id: 'evidence-1',
  orchestrationId: 'orchestration-1',
  stageId: 'test',
  kind: 'test',
  status: 'passed',
  command: 'npm run test',
  exitCode: 0,
  summary: '模块测试通过',
  capturedBy: 'host',
  runId: 'run-1',
  taskId: 'task-1',
  taskExecutionId: 'run-1:task-1',
  attemptId: 'run-1:task-1:attempt-1',
  createdAt: '2026-09-12T10:00:00.000Z',
}];

const scope: AgentScope = {
  allowedFiles: ['src/app.ts'],
  allowedDataClasses: ['evidence', 'task'],
  allowedTools: ['read-evidence'],
  allowedAgentRoles: ['module-lead'],
  maxDelegationDepth: 0,
  maxFanOut: 0,
  maxTokens: 2_000,
  maxCalls: 5,
  maxMoneyCents: 0,
  maxDurationMs: 30_000,
  expiresAt: '2026-09-12T12:00:00.000Z',
};

describe('bounded evidence retrieval', () => {
  it('allows exact evidence lookup only when the scope grants evidence data', () => {
    const index = buildEvidenceIndex({ projectId: 'project-1', sourceVersion: 3, evidence, acceptances: [] });

    expect(queryEvidenceWithinScope(index, {
      scope,
      exactIds: ['evidence-1'],
      limit: 10,
      maxTokens: 500,
    })).toMatchObject({
      status: 'ok',
      selection: 'exact-reference',
      entries: [{ id: 'evidence-1' }],
    });
    expect(queryEvidenceWithinScope(index, {
      scope: { ...scope, allowedDataClasses: ['task'] },
      exactIds: ['evidence-1'],
      limit: 10,
      maxTokens: 500,
    })).toMatchObject({ status: 'out-of-scope', entries: [] });
  });

  it('labels keyword results as candidates and keeps them bounded', () => {
    const index = buildEvidenceIndex({ projectId: 'project-1', sourceVersion: 3, evidence, acceptances: [] });
    const result = queryEvidenceWithinScope(index, {
      scope,
      keywords: ['test'],
      limit: 1,
      maxTokens: 500,
    });

    expect(result).toMatchObject({
      status: 'ok',
      selection: 'keyword-candidate',
      authoritative: false,
      budget: { maxTokens: 500, returned: 1 },
    });
  });

  it('rejects a project mismatch before consulting the index', () => {
    const index = buildEvidenceIndex({ projectId: 'project-1', sourceVersion: 3, evidence, acceptances: [] });

    expect(queryEvidenceWithinScope(index, {
      scope,
      projectId: 'project-2',
      limit: 10,
      maxTokens: 500,
    })).toMatchObject({ status: 'out-of-scope', entries: [] });
  });
});
