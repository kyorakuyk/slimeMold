import { describe, expect, it } from 'vitest';
import './sessionContracts';
import type { AcceptancePersistence, AcceptanceRecord, CleanupApproval } from './sessionContracts';

describe('dev session contract owner', () => {
  it('preserves acceptance and cleanup approval persistence contracts', () => {
    const record: AcceptanceRecord = {
      acceptanceId: 'acceptance-1',
      orchestrationId: 'orchestration-1',
      stageId: 'stage-1',
      worktreePath: 'C:/worktree',
      passed: true,
      failedChecks: [],
      at: '2026-09-22T00:00:00.000Z',
    };
    const approval: CleanupApproval = {
      worktreePath: record.worktreePath,
      approvedAt: record.at,
      consumed: false,
    };
    const persistence: AcceptancePersistence = {
      append: async () => undefined,
      load: async () => [record],
    };

    expect(approval.consumed).toBe(false);
    expect(persistence.load).toBeTypeOf('function');
  });
});
