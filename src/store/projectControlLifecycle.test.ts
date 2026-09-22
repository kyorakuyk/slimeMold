import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { createEmptyProjectControlSnapshot } from '../projectControl/persistence';
import {
  clearProjectEventBuffer,
  getPendingProjectEvents,
  recordProjectEvents,
} from '../projectControl/eventBuffer';
import { getActiveWorkerRunRuntime } from '../projectControl/workerRunRuntime';
import {
  activateProjectControlRuntime,
  createProjectControlStoreAdapter,
  emptyProjectControlRuntimeState,
  type ProjectControlRuntimeInput,
  installProjectControlRuntime,
  normalizeProjectControlSnapshot,
  resetProjectControlLifecycle,
} from './projectControlLifecycle';

beforeEach(() => {
  resetProjectControlLifecycle();
});

describe('project control lifecycle adapter', () => {
  it('keeps injected reset and activation sequencing store-agnostic', () => {
    const calls: string[] = [];
    const clearPendingProjectEvents = (projectId: string) => calls.push(`events:${projectId}`);
    const clearWorkerRunRuntime = () => calls.push('runtime:clear');
    const installWorkerRunRuntime = vi.fn((input: ProjectControlRuntimeInput) => {
      calls.push(`runtime:install:${(input as { projectId: string }).projectId}`);
      return { recoveries: ['recovery'] as never };
    });
    const adapter = createProjectControlStoreAdapter({
      clearPendingProjectEvents,
      clearWorkerRunRuntime,
      installWorkerRunRuntime,
    });

    adapter.resetProjectControlLifecycle('project-1');
    adapter.resetProjectControlLifecycle();
    const input = { projectId: 'project-2', taskGraphs: [], runs: [] } as never;
    const projection = adapter.activateProjectControlRuntime(input);

    expect(calls).toEqual([
      'events:project-1',
      'runtime:clear',
      'runtime:clear',
      'events:project-2',
      'runtime:install:project-2',
    ]);
    expect(installWorkerRunRuntime).toHaveBeenCalledWith(input);
    expect(projection).toEqual({
      workerRunRecoveries: ['recovery'],
      workerRunEvidence: [],
      workerRunSideEffects: [],
      workerCleanupProposals: [],
    });
  });

  it('normalizes project control snapshots at the lifecycle boundary', () => {
    const normalized = normalizeProjectControlSnapshot({
      version: 1,
      activeSessionId: 'missing',
      sessions: [],
      decisions: [],
      briefs: [],
    } as never);

    expect(normalized.activeSessionId).toBeNull();
    expect(normalized).toEqual(expect.objectContaining({
      architectures: [],
      issues: [],
      masterAgentId: null,
    }));
  });

  it('returns an empty runtime projection for a new project', () => {
    expect(emptyProjectControlRuntimeState()).toEqual({
      workerRunRecoveries: [],
      workerRunEvidence: [],
      workerRunSideEffects: [],
      workerCleanupProposals: [],
    });
  });

  it('installs Worker runtime and exposes only its recovery projection', () => {
    const runtime = installProjectControlRuntime({
      projectId: 'project-1',
      taskGraphs: [],
      runs: [],
    });

    expect(runtime).toEqual(emptyProjectControlRuntimeState());
    expect(getActiveWorkerRunRuntime()?.projectId).toBe('project-1');
  });

  it('owns project activation cleanup before installing Worker runtime', () => {
    recordProjectEvents('project-1', [{
      eventId: 'pending-project-event',
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Project',
      aggregateId: 'project-1',
      aggregateVersion: 1,
      eventType: 'ProjectCreated',
      schemaVersion: 1,
      payload: {},
      actor: 'user',
      occurredAt: '2026-09-01T00:00:00.000Z',
    }]);

    const runtime = activateProjectControlRuntime({
      projectId: 'project-1',
      taskGraphs: [],
      runs: [],
    });

    expect(runtime).toEqual(emptyProjectControlRuntimeState());
    expect(getPendingProjectEvents('project-1')).toEqual([]);
  });
  it('clears pending events and active Worker runtime together', () => {
    recordProjectEvents('project-1', [{
      eventId: 'project-created',
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Project',
      aggregateId: 'project-1',
      aggregateVersion: 1,
      eventType: 'ProjectCreated',
      schemaVersion: 1,
      payload: {},
      actor: 'user',
      occurredAt: '2026-09-01T00:00:00.000Z',
    }]);
    installProjectControlRuntime({ projectId: 'project-1', taskGraphs: [], runs: [] });

    resetProjectControlLifecycle('project-1');

    expect(getPendingProjectEvents('project-1')).toEqual([]);
    expect(getActiveWorkerRunRuntime()).toBeNull();
  });

  it('keeps the canonical empty snapshot available to the store facade', () => {
    expect(normalizeProjectControlSnapshot(createEmptyProjectControlSnapshot())).toEqual(
      createEmptyProjectControlSnapshot(),
    );
  });

  afterEach(() => {
    clearProjectEventBuffer('project-1');
    resetProjectControlLifecycle();
  });
});
