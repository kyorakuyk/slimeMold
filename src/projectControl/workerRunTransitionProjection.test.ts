import { describe, expect, it } from 'vitest';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types';
import {
  projectWorkerRunTransition,
} from './workerRunTransitionProjection';

const run = (runId: string, orchestrationId?: string): WorkerRunQueueState => ({
  runId,
  projectId: 'project-1',
  orchestrationId,
  status: 'running',
  tasks: [],
  updatedAt: `${runId}-updated`,
} as unknown as WorkerRunQueueState);

const orchestration = (id: string): Orchestration => ({
  id,
  goal: 'test orchestration',
  status: 'ready',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  draft: { stages: [], edges: [] },
  stageLogs: [],
  runIds: [],
} as Orchestration);

describe('projectWorkerRunTransition', () => {
  it('replaces only the matching run and preserves unmatched references', () => {
    const unmatched = run('other', 'orchestration-1');
    const current = run('target', 'orchestration-1');
    const transition = run('target', 'orchestration-1');

    const result = projectWorkerRunTransition({
      currentWorkerRuns: [unmatched, current],
      currentOrchestrations: [orchestration('orchestration-1')],
      transition,
    });

    expect(result.nextWorkerRuns).toHaveLength(2);
    expect(result.nextWorkerRuns[0]).toBe(unmatched);
    expect(result.nextWorkerRuns[1]).toBe(transition);
    expect(result.nextWorkerRuns).not.toBe([unmatched, current]);
    expect(result.nextOrchestrations).toHaveLength(1);
  });

  it('does not append a transition when its run id is absent', () => {
    const existing = run('existing', 'orchestration-1');
    const transition = run('missing', 'orchestration-1');

    const result = projectWorkerRunTransition({
      currentWorkerRuns: [existing],
      currentOrchestrations: [orchestration('orchestration-1')],
      transition,
    });

    expect(result.nextWorkerRuns).toEqual([existing]);
    expect(result.nextWorkerRuns).not.toContain(transition);
  });

  it('returns new collection data without mutating the caller-owned input arrays', () => {
    const currentWorkerRuns = [run('target', 'orchestration-1')];
    const currentOrchestrations = [orchestration('orchestration-1')];
    const transition = run('target', 'orchestration-1');

    const result = projectWorkerRunTransition({
      currentWorkerRuns,
      currentOrchestrations,
      transition,
    });

    expect(result.nextWorkerRuns).not.toBe(currentWorkerRuns);
    expect(result.nextOrchestrations).not.toBe(currentOrchestrations);
    expect(currentWorkerRuns[0]).not.toBe(transition);
    expect(currentOrchestrations).toHaveLength(1);
  });
});
