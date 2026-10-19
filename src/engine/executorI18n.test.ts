import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { useWorkflowStore } from '../store/workflowStore';

vi.mock('../platform/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/env')>()),
  isTauri: true,
}));

import { runWorkflow } from './executor';

describe('runWorkflow localized dev-session diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('localizes only the visible log and preserves the durable RunResult error', async () => {
    const originalLanguage = i18n.language;
    const originalState = useWorkflowStore.getState();
    const addLog = vi.spyOn(originalState, 'addLog');
    try {
      await i18n.changeLanguage('en-US');
      useWorkflowStore.setState({
        activeWfId: 'wf-i18n-dev-session',
        nodes: [{ id: 'dev-node', data: { typeId: 'dev.test' } }] as never,
        projectPath: null,
      });

      const result = await runWorkflow({ wfId: 'wf-i18n-dev-session' });

      expect(result).toMatchObject({
        status: 'aborted',
        error: '包含 dev.* 节点的工作流必须先打开已保存项目',
      });
      expect(addLog).toHaveBeenCalledWith(
        'error',
        'Workflows containing dev.* nodes require an opened, saved project first',
      );
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
      useWorkflowStore.setState({
        activeWfId: originalState.activeWfId,
        nodes: originalState.nodes,
        projectPath: originalState.projectPath,
      });
    }
  });
});
