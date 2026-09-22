import { describe, expect, it } from 'vitest';
import type { AcceptanceRecord } from '../dev/session';
import type { EvidenceRecord } from '../dev/evidence';
import {
  buildEvidenceIndex,
  queryEvidenceIndex,
} from './evidenceIndex';

const evidence: EvidenceRecord[] = [
  {
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
  },
  {
    id: 'evidence-2',
    orchestrationId: 'orchestration-1',
    stageId: 'diff',
    kind: 'diff',
    status: 'unknown',
    summary: '等待宿主读取 diff',
    capturedBy: 'host',
    runId: 'run-1',
    taskId: 'task-2',
    taskExecutionId: 'run-1:task-2',
    attemptId: 'run-1:task-2:attempt-1',
    createdAt: '2026-09-12T10:01:00.000Z',
  },
];

const acceptances: AcceptanceRecord[] = [{
  acceptanceId: 'acceptance-1',
  orchestrationId: 'orchestration-1',
  stageId: 'test',
  worktreePath: 'D:/fixture/worktree',
  passed: true,
  failedChecks: [],
  at: '2026-09-12T10:02:00.000Z',
  runId: 'run-1',
  taskId: 'task-1',
  taskExecutionId: 'run-1:task-1',
  attemptId: 'run-1:task-1:attempt-1',
}];

describe('evidence index and bounded lookup', () => {
  it('indexes evidence and acceptance metadata without storing transcripts', () => {
    const index = buildEvidenceIndex({
      projectId: 'project-1',
      sourceVersion: 3,
      evidence,
      acceptances,
    });

    expect(index).toMatchObject({ projectId: 'project-1', sourceVersion: 3 });
    expect(index.entries).toHaveLength(3);
    expect(index.entries.find((entry) => entry.id === 'evidence-1')).toMatchObject({
      kind: 'test',
      status: 'passed',
      taskId: 'task-1',
    });
    expect(index.entries[0]).not.toHaveProperty('transcript');
  });

  it('prioritizes exact IDs and reports not-found separately', () => {
    const index = buildEvidenceIndex({ projectId: 'project-1', sourceVersion: 3, evidence, acceptances });

    expect(queryEvidenceIndex(index, {
      exactIds: ['evidence-1'],
      limit: 10,
    })).toMatchObject({ status: 'ok', entries: [{ id: 'evidence-1' }] });
    expect(queryEvidenceIndex(index, {
      exactIds: ['missing-evidence'],
      limit: 10,
    })).toMatchObject({ status: 'not-found', entries: [] });
  });

  it('supports keyword candidates, bounded results, and project scope rejection', () => {
    const index = buildEvidenceIndex({ projectId: 'project-1', sourceVersion: 3, evidence, acceptances });

    expect(queryEvidenceIndex(index, {
      keywords: ['test'],
      limit: 1,
    })).toMatchObject({ status: 'truncated', entries: [{ id: 'evidence-1' }] });
    expect(queryEvidenceIndex(index, {
      projectId: 'project-2',
      limit: 10,
    })).toMatchObject({ status: 'out-of-scope', entries: [] });
  });
});
