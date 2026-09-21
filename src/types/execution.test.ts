import { describe, expect, it } from 'vitest';
import type { LogEntry, RunNodeResult, RunRecord } from './execution';

describe('execution contract owner', () => {
  it('keeps run records and logs structurally usable', () => {
    const node: RunNodeResult = {
      id: 'node-1',
      label: 'Node',
      typeId: 'test.node',
      status: 'success',
      outputs: {},
      error: null,
      startedAt: null,
      durationMs: null,
    };
    const run: RunRecord = {
      id: 'run-1',
      name: 'Run',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:00:01.000Z',
      durationMs: 1000,
      status: 'success',
      nodeCount: 1,
      nodes: [node],
    };
    const log: LogEntry = {
      time: run.endedAt,
      level: 'info',
      message: 'done',
    };

    expect(run.nodes[0]).toBe(node);
    expect(log.level).toBe('info');
  });
});
