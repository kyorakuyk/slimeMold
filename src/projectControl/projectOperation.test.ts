import { describe, expect, it } from 'vitest';
import { createProjectOperationGuard } from './projectOperation';

describe('project operation guard', () => {
  it('reuses a live operation for the same project identity', () => {
    let state = { projectId: 'p1', projectPath: 'C:/p1' };
    const guard = createProjectOperationGuard(() => state);
    const first = guard.get('p1', 'C:/p1');
    const second = guard.get('p1', 'C:/p1');
    expect(second).toBe(first);
    expect(first.controller.signal.aborted).toBe(false);
  });

  it('aborts the previous operation when project identity changes', () => {
    const guard = createProjectOperationGuard(() => ({ projectId: 'p1', projectPath: 'C:/p1' }));
    const first = guard.get('p1', 'C:/p1');
    const second = guard.get('p2', 'C:/p2');
    expect(first.controller.signal.aborted).toBe(true);
    expect(second).not.toBe(first);
  });

  it('fails closed for cancellation and current-state drift', () => {
    let state = { projectId: 'p1', projectPath: 'C:/p1' };
    const guard = createProjectOperationGuard(() => state);
    const operation = guard.get('p1', 'C:/p1');
    operation.controller.abort();
    expect(() => guard.assert(operation)).toThrowError(expect.objectContaining({
      name: 'AbortError',
      message: '项目 operation 已取消',
    }));

    const fresh = guard.get('p1', 'C:/p1');
    state = { projectId: 'p2', projectPath: 'C:/p2' };
    expect(() => guard.assert(fresh)).toThrow('项目在异步 operation 期间发生切换');
    expect(fresh.controller.signal.aborted).toBe(true);
  });

  it('clears and aborts the current operation idempotently', () => {
    const guard = createProjectOperationGuard(() => ({ projectId: 'p1', projectPath: 'C:/p1' }));
    const operation = guard.get('p1', 'C:/p1');
    guard.clear();
    guard.clear();
    expect(operation.controller.signal.aborted).toBe(true);
  });
});
