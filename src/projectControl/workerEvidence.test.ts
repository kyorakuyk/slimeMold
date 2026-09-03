import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../dev/evidence';
import type { SideEffectRecord } from '../domain/contracts';
import { loadWorkerEvidence, loadWorkerSideEffects, mergeWorkerEvidence, mergeWorkerSideEffects } from './workerEvidence';

function evidence(id: string, summary: string): EvidenceRecord {
  return {
    id,
    orchestrationId: 'orch-1',
    stageId: 'task-1',
    kind: 'test',
    status: 'passed',
    command: 'npm run test',
    exitCode: 0,
    summary,
    capturedBy: 'host',
    worktreePath: 'C:/project-workers/run-1/task-1',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('worker evidence projection', () => {
  it('rejects forged non-host evidence before merging', async () => {
    await expect(loadWorkerEvidence({
      load: async () => [
        evidence('ev-1', '旧摘要'),
        { ...evidence('ev-agent', '模型自报'), capturedBy: 'agent' as never },
      ],
    })).rejects.toThrow(/capturedBy/);

    const loaded = [evidence('ev-1', '旧摘要')];
    const merged = mergeWorkerEvidence(
      [evidence('ev-1', '内存摘要')],
      [...loaded, evidence('ev-2', '新摘要')],
    );

    expect(merged).toEqual([
      expect.objectContaining({ id: 'ev-1', summary: '旧摘要' }),
      expect.objectContaining({ id: 'ev-2', summary: '新摘要' }),
    ]);
  });

  it('does not mutate either evidence source', () => {
    const current = [evidence('ev-1', '当前')];
    const incoming = [evidence('ev-2', '新增')];

    mergeWorkerEvidence(current, incoming);

    expect(current).toEqual([evidence('ev-1', '当前')]);
    expect(incoming).toEqual([evidence('ev-2', '新增')]);
  });

  it('loads and merges side-effect receipts without treating a repair-needed journal as valid', async () => {
    const effect: SideEffectRecord = {
      idempotencyKey: 'worker-exec:run-1:task-1:attempt-1',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'task-1:1:1',
      runId: 'run-1',
      taskId: 'task-1',
      status: 'receipt',
      recovery: 'skip',
      receipt: { receiptId: 'receipt-1', observedAt: '2026-09-01T00:01:00.000Z' },
    };
    const repository = {
      read: async () => ({ status: 'ok' as const, journal: { schemaVersion: 1 as const, entries: [effect] } }),
    };

    const loaded = await loadWorkerSideEffects(repository);
    expect(mergeWorkerSideEffects([], loaded)).toEqual([effect]);
    await expect(loadWorkerSideEffects({
      read: async () => ({
        status: 'needs-repair' as const,
        journal: { schemaVersion: 1 as const, entries: [] },
        reason: 'bad json',
      }),
    })).rejects.toThrow('副作用账本需要修复');
  });
});
