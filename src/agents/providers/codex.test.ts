import { describe, expect, it } from 'vitest';
import { codexWorkerExec } from './codex';

describe('codexWorkerExec', () => {
  it('fails closed outside the Tauri desktop host', async () => {
    await expect(codexWorkerExec('implement task', 'gpt-worker', 'C:/worktree', 'operation-test'))
      .rejects.toThrow(/桌面版/);
  });
});
