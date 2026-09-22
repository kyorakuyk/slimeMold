import { describe, expect, it } from 'vitest';
import './runTypes';
import type { RunOptions, RunResult } from './runTypes';
import type {
  RunOptions as ExecutorRunOptions,
  RunResult as ExecutorRunResult,
} from './executor';

describe('run contract owner', () => {
  it('keeps run options and results explicit and composable', () => {
    const options: RunOptions = {
      wfId: 'workflow-1',
      incremental: true,
      retryFailed: true,
      sandboxMode: 'copy',
    };
    const result: RunResult = { status: 'success', runId: 7 };
    const executorOptions: ExecutorRunOptions = options;
    const executorResult: ExecutorRunResult = result;

    expect(options.incremental).toBe(true);
    expect(options.retryFailed).toBe(true);
    expect(result).toEqual({ status: 'success', runId: 7 });
    expect(executorOptions).toEqual(options);
    expect(executorResult).toEqual(result);
  });
});
