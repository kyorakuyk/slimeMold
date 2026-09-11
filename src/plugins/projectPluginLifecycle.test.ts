import { describe, expect, it } from 'vitest';
import {
  createProjectPluginLifecycleScheduler,
  shouldReloadProjectPlugins,
  type ProjectPluginContext,
} from './projectPluginLifecycle';

const ctx = (projectId: string | null, projectPath: string | null): ProjectPluginContext => ({
  projectId,
  projectPath,
});

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('project plugin lifecycle scheduler', () => {
  it('coalesces same-turn project changes and preserves the original predecessor', async () => {
    const transitions: Array<{ previous: ProjectPluginContext | null; next: ProjectPluginContext; epoch: number }> = [];
    const scheduler = createProjectPluginLifecycleScheduler((transition) => {
      transitions.push(transition);
      // Simulate an addLog/store write re-entering the subscriber synchronously.
      scheduler.observe(transition.next);
    });

    scheduler.observe(ctx('project-a', 'D:/one'));
    scheduler.observe(ctx('project-b', 'D:/two'));
    scheduler.observe(ctx('project-c', 'D:/three'));
    await flushMicrotasks();

    expect(transitions).toEqual([{
      previous: null,
      next: ctx('project-c', 'D:/three'),
      epoch: 3,
    }]);
    expect(scheduler.isCurrent(3, ctx('project-c', 'D:/three'))).toBe(true);
    scheduler.dispose();
  });

  it('invalidates an in-flight transition when a newer project is observed', async () => {
    const seen: Array<{ epoch: number; next: ProjectPluginContext }> = [];
    const scheduler = createProjectPluginLifecycleScheduler((transition) => {
      seen.push({ epoch: transition.epoch, next: transition.next });
    });

    scheduler.observe(ctx('project-a', 'D:/one'));
    await flushMicrotasks();
    scheduler.observe(ctx('project-b', 'D:/two'));
    expect(scheduler.isCurrent(1, ctx('project-a', 'D:/one'))).toBe(false);
    expect(scheduler.isCurrent(2, ctx('project-b', 'D:/two'))).toBe(true);
    await flushMicrotasks();

    expect(seen.map((item) => item.epoch)).toEqual([1, 2]);
    scheduler.dispose();
  });
});

describe('shouldReloadProjectPlugins', () => {
  it('does not reload for ordinary updates inside the same project', () => {
    expect(shouldReloadProjectPlugins('project-1', 'project-1', 'D:/one', 'D:/one')).toBe(false);
  });

  it('reloads when a project is opened, switched, or closed', () => {
    expect(shouldReloadProjectPlugins(null, 'project-1', null, 'D:/one')).toBe(true);
    expect(shouldReloadProjectPlugins('project-1', 'project-2', 'D:/one', 'D:/two')).toBe(true);
    expect(shouldReloadProjectPlugins('project-1', null, 'D:/one', null)).toBe(true);
  });

  it('reloads when the path changes even if a copied project keeps the same id', () => {
    expect(shouldReloadProjectPlugins('project-1', 'project-1', 'D:/one', 'E:/copy')).toBe(true);
  });
});
