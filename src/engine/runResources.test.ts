import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupRun,
  createRunResources,
  getRunResources,
} from './runResources';

describe('runResources', () => {
  beforeEach(async () => {
    // 测试环境不是 Tauri；清理只会释放内存中的资源登记。
    await cleanupRun('wf-test', 1);
    await cleanupRun('wf-test', 2);
  });

  it('按 wfId + runId 保存独立资源', () => {
    const first = createRunResources('wf-test', 1);
    const second = createRunResources('wf-test', 2);

    first.sandboxRoots.add('/tmp/run-1');
    first.worktree = { cwd: '/tmp/repo', path: '/tmp/wt-1', branch: 'slime-sandbox-1' };
    second.sandboxRoots.add('/tmp/run-2');

    expect(getRunResources('wf-test', 1)).toBe(first);
    expect(getRunResources('wf-test', 2)).toBe(second);
    expect(getRunResources('wf-test', 1)?.sandboxRoots).toEqual(new Set(['/tmp/run-1']));
    expect(getRunResources('wf-test', 2)?.sandboxRoots).toEqual(new Set(['/tmp/run-2']));
  });

  it('清理旧 run 不会删除新 run 的登记', async () => {
    const oldRun = createRunResources('wf-test', 10);
    const newRun = createRunResources('wf-test', 11);
    oldRun.sandboxRoots.add('/tmp/old');
    newRun.sandboxRoots.add('/tmp/new');

    await cleanupRun('wf-test', 10);

    expect(getRunResources('wf-test', 10)).toBeUndefined();
    expect(getRunResources('wf-test', 11)).toBe(newRun);
    expect(newRun.sandboxRoots).toEqual(new Set(['/tmp/new']));
  });

  it('清理指定 run 后可安全重复调用', async () => {
    createRunResources('wf-test', 20);

    await cleanupRun('wf-test', 20);
    await expect(cleanupRun('wf-test', 20)).resolves.toBeUndefined();
    expect(getRunResources('wf-test', 20)).toBeUndefined();
  });
});
