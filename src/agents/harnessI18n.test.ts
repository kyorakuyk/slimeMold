import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types/agent';
import type { ExecContext } from '../types/node';
import i18n from '../i18n';
import { buildHarnessOptions } from './harness';

describe('AgentHarness localized log projection', () => {
  it('localizes display logs while leaving model and trajectory event text intact', async () => {
    const originalLanguage = i18n.language;
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const ctx = {
      logger: { info, warn, error },
      setPartial: vi.fn(),
    } as unknown as ExecContext;
    const options = buildHarnessOptions({
      ctx,
      agent: { model: 'model-test' } as AgentConfig,
      prompt: 'run',
    });
    const original = 'Harness 第 2 轮 / 模型 model-test';

    try {
      await i18n.changeLanguage('en-US');
      options.events?.onLog?.('info', original);
      options.events?.onLog?.('warn', '瞬时错误（1/2）： gateway timeout，退避重试');
      options.events?.onToolCall?.({
        round: 2,
        name: 'read_file',
        args: {},
        error: 'permission denied',
      });
      expect(info).toHaveBeenCalledWith('Harness round 2 / model model-test');
      expect(warn).toHaveBeenCalledWith(
        'Transient error (1/2): gateway timeout; retrying with backoff',
      );
      expect(error).toHaveBeenCalledWith('Tool read_file failed: permission denied');
      expect(original).toBe('Harness 第 2 轮 / 模型 model-test');
    } finally {
      await i18n.changeLanguage(originalLanguage || 'zh-CN');
    }
  });
});
