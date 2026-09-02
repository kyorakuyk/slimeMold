import { describe, expect, it } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { canStartLegacyOrchestration } from './executionBoundary';

function run(orchestrationId: string, status: WorkerRunQueueState['status']): WorkerRunQueueState {
  return {
    version: 1,
    projectId: 'project-1',
    runId: `${orchestrationId}-${status}`,
    orchestrationId,
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    tasks: {},
  };
}

describe('legacy orchestration execution boundary', () => {
  it('allows legacy execution only when no Worker Run owns the orchestration', () => {
    expect(canStartLegacyOrchestration('orch-1', [])).toEqual({ allowed: true });
    expect(canStartLegacyOrchestration('orch-1', [run('orch-2', 'queued')])).toEqual({ allowed: true });
  });

  it('blocks the old executor for every linked Worker Run state', () => {
    for (const status of ['queued', 'running', 'partial', 'blocked', 'failed', 'cancelled', 'succeeded'] as const) {
      expect(canStartLegacyOrchestration('orch-1', [run('orch-1', status)])).toEqual({
        allowed: false,
        reason: '该编排已由 Worker Run 接管，不能启动旧 executor',
      });
    }
  });
});
