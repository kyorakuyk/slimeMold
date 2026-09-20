import { describe, expect, it, vi } from 'vitest';
import type { DevSession } from '../dev/session';
import {
  admitWorkerRunSession,
  type WorkerRunSessionAdmissionDeps,
} from './workerRunSessionAdmission';

const session = { hostGeneration: 7 } as unknown as DevSession;

function deps(overrides: Partial<WorkerRunSessionAdmissionDeps> = {}) {
  const trace: string[] = [];
  const controller = new AbortController();
  const base: WorkerRunSessionAdmissionDeps = {
    projectId: 'project-1',
    projectPath: 'C:/project',
    signal: controller.signal,
    saveProject: vi.fn(async (guard) => {
      trace.push(`save:${guard.projectId}:${guard.projectPath}`);
    }),
    assertOperation: vi.fn(() => trace.push('assert')),
    ensureGuiDevSession: vi.fn(async () => {
      trace.push('ensure-session');
      return session;
    }),
    getDevGuiError: vi.fn(() => {
      trace.push('gui-error');
      return undefined;
    }),
    getCurrentProjectId: vi.fn(() => {
      trace.push('current-project');
      return 'project-1';
    }),
    ...overrides,
  };
  return { base, trace, controller };
}

describe('admitWorkerRunSession', () => {
  it('preserves initial save, session admission, and identity fence order', async () => {
    const fixture = deps();

    await expect(admitWorkerRunSession(fixture.base)).resolves.toBe(session);

    expect(fixture.trace).toEqual([
      'save:project-1:C:/project',
      'assert',
      'ensure-session',
      'assert',
      'current-project',
    ]);
    expect(fixture.base.saveProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      projectPath: 'C:/project',
      signal: fixture.controller.signal,
    });
  });

  it('preserves the exact unavailable-host error and suppresses later checks', async () => {
    const fixture = deps({
      ensureGuiDevSession: vi.fn(async () => null),
      getDevGuiError: vi.fn(() => 'host not ready'),
    });

    await expect(admitWorkerRunSession(fixture.base))
      .rejects.toThrow('开发宿主不可用，Worker 未启动：host not ready');
    expect(fixture.base.getDevGuiError).toHaveBeenCalledTimes(1);
    expect(fixture.base.assertOperation).toHaveBeenCalledTimes(1);
    expect(fixture.base.getCurrentProjectId).not.toHaveBeenCalled();
  });

  it('rejects stale project identity after session admission', async () => {
    const fixture = deps({
      getCurrentProjectId: vi.fn(() => 'different-project'),
    });

    await expect(admitWorkerRunSession(fixture.base))
      .rejects.toThrow('项目在 Worker 启动前发生切换');
    expect(fixture.base.assertOperation).toHaveBeenCalledTimes(2);
  });

  it('propagates initial save failure without opening the host session', async () => {
    const saveFailure = new Error('save unavailable');
    const fixture = deps({
      saveProject: vi.fn(async () => { throw saveFailure; }),
    });

    await expect(admitWorkerRunSession(fixture.base)).rejects.toBe(saveFailure);
    expect(fixture.base.ensureGuiDevSession).not.toHaveBeenCalled();
    expect(fixture.base.assertOperation).not.toHaveBeenCalled();
  });
});
