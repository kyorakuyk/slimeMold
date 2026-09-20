import { describe, expect, it } from 'vitest';
import { createWorkerRecoverySingleFlight } from './workerRecoverySingleFlight';

describe('worker recovery single-flight', () => {
  it('rejects a second lease for the same project/path/run', () => {
    const guard = createWorkerRecoverySingleFlight();
    const key = { projectId: 'project-1', projectPath: 'C:/project', runId: 'run-1' };
    const first = guard.acquire(key);

    expect(first).not.toBeNull();
    expect(guard.acquire(key)).toBeNull();
  });

  it('allows different runs and projects concurrently', () => {
    const guard = createWorkerRecoverySingleFlight();
    const first = guard.acquire({ projectId: 'project-1', projectPath: 'C:/project', runId: 'run-1' });

    expect(guard.acquire({ projectId: 'project-1', projectPath: 'C:/project', runId: 'run-2' })).not.toBeNull();
    expect(guard.acquire({ projectId: 'project-2', projectPath: 'C:/project-2', runId: 'run-1' })).not.toBeNull();
    first?.release();
  });

  it('releases after completion and prevents an old lease from clearing a newer lease', () => {
    const guard = createWorkerRecoverySingleFlight();
    const key = { projectId: 'project-1', projectPath: 'C:/project', runId: 'run-1' };
    const first = guard.acquire(key);
    first?.release();
    const second = guard.acquire(key);

    first?.release();
    expect(guard.acquire(key)).toBeNull();
    second?.release();
    expect(guard.acquire(key)).not.toBeNull();
  });
});
