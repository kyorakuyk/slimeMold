import { describe, expect, it } from 'vitest';
import { ExecutionCoordinator } from './executionCoordinator';

describe('ExecutionCoordinator', () => {
  it('按 workflow 隔离并递增运行代次', () => {
    const coordinator = new ExecutionCoordinator();

    const first = coordinator.start('wf-a', { running: false, force: false });
    const other = coordinator.start('wf-b', { running: false, force: false });
    const second = coordinator.start('wf-a', { running: false, force: false });

    expect(first.status).toBe('started');
    expect(other.status).toBe('started');
    expect(second.status).toBe('started');
    if (first.status !== 'started' || other.status !== 'started' || second.status !== 'started') return;

    expect(first.runId).toBe(1);
    expect(other.runId).toBe(1);
    expect(second.runId).toBe(2);
    expect(coordinator.getCurrentRunId('wf-a')).toBe(2);
    expect(coordinator.getActiveRunId('wf-a')).toBe(2);
    expect(coordinator.isCurrent('wf-a', first.runId)).toBe(false);
    expect(coordinator.isCurrent('wf-a', second.runId)).toBe(true);
  });

  it('拒绝有效运行的重复启动，force 会中止旧运行并建立新 fencing', () => {
    const coordinator = new ExecutionCoordinator();
    const first = coordinator.start('wf', { running: false, force: false });
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;

    const duplicate = coordinator.start('wf', { running: true, force: false });
    expect(duplicate).toEqual({ status: 'rejected', runId: 1, reason: 'already-running' });

    const forced = coordinator.start('wf', { running: true, force: true });
    expect(forced.status).toBe('started');
    if (forced.status !== 'started') return;

    expect(first.signal.aborted).toBe(true);
    expect(forced.runId).toBe(2);
    expect(coordinator.isCurrent('wf', first.runId)).toBe(false);
    expect(coordinator.isCurrent('wf', forced.runId)).toBe(true);
  });

  it('stop 会中止当前运行并推进 current/active fence', () => {
    const coordinator = new ExecutionCoordinator();
    const started = coordinator.start('wf', { running: false, force: false });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    const stopped = coordinator.stop('wf');

    expect(started.signal.aborted).toBe(true);
    expect(stopped).toEqual({ abortedRunId: 1, currentRunId: 2, activeRunId: 2 });
    expect(coordinator.isCurrent('wf', started.runId)).toBe(false);
  });

  it('当前运行 abort 不推进 generation，旧句柄不能取消后续运行', () => {
    const coordinator = new ExecutionCoordinator();
    const first = coordinator.start('wf', { running: false, force: false });
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;

    expect(first.abort()).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(coordinator.getCurrentRunId('wf')).toBe(1);

    const second = coordinator.start('wf', { running: false, force: false });
    expect(second.status).toBe('started');
    if (second.status !== 'started') return;
    expect(first.abort()).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('旧运行 finish 不会清掉被 force 接管的新运行', () => {
    const coordinator = new ExecutionCoordinator();
    const first = coordinator.start('wf', { running: false, force: false });
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;

    const second = coordinator.start('wf', { running: true, force: true });
    expect(second.status).toBe('started');
    if (second.status !== 'started') return;

    expect(coordinator.finish('wf', first.runId)).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(coordinator.finish('wf', second.runId)).toBe(true);
  });
});
