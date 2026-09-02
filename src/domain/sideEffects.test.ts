import { describe, expect, it } from 'vitest';
import { createSideEffect, startSideEffect, completeSideEffect } from './contracts';
import {
  SideEffectJournalRepository,
  createEmptySideEffectJournal,
  parseSideEffectJournal,
  recoverInterruptedSideEffect,
  recordSideEffect,
  serializeSideEffectJournal,
} from './sideEffects';
import { InMemoryEventStoreAdapter } from './eventStore';
import { createAttemptId, createTaskExecutionId } from './execution';

const planned = createSideEffect({
  idempotencyKey: 'push:task-1:commit-a',
  kind: 'push',
  target: 'refs/heads/feature/task-1',
  inputHash: 'tree-a',
});

describe('side-effect journal', () => {
  it('rejects a side-effect factory payload with forged run/task lineage', () => {
    const wrongExecutionId = createTaskExecutionId('other-run', 'task-1');
    expect(() => createSideEffect({
      idempotencyKey: 'worker-execution:forged-factory',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'input-1',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: wrongExecutionId,
      attemptId: createAttemptId(wrongExecutionId, 1),
    })).toThrow(/lineage|execution|attempt/);
  });

  it('records idempotent progress and rejects key reuse for a different target or input', () => {
    const initial = createEmptySideEffectJournal();
    const started = startSideEffect(planned);
    const journal = recordSideEffect(recordSideEffect(initial, planned), started);

    expect(journal.entries).toEqual([started]);
    expect(recordSideEffect(journal, started)).toBe(journal);
    expect(() => recordSideEffect(journal, {
      ...planned,
      target: 'refs/heads/main',
    })).toThrow(/idempotencyKey/);
  });

  it('marks an interrupted started effect unknown and lets a later receipt close it', () => {
    const started = startSideEffect(planned);
    const unknown = recoverInterruptedSideEffect(started);
    expect(unknown).toMatchObject({ status: 'unknown', recovery: 'needs-user' });

    const receipt = completeSideEffect(started, {
      receiptId: 'push-receipt-1',
      observedAt: '2026-09-01T00:03:00.000Z',
      outputHash: 'remote-tree-a',
    });
    const journal = recordSideEffect(
      recordSideEffect(createEmptySideEffectJournal(), unknown),
      receipt,
    );
    expect(journal.entries[0]).toMatchObject({ status: 'receipt', recovery: 'skip', receipt: receipt.receipt });
  });

  it('rejects a same-key lifecycle record that changes execution lineage', () => {
    const taskExecutionId = createTaskExecutionId('run-side-effect', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = startSideEffect(createSideEffect({
      idempotencyKey: 'worker-execution:lineage-key',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'input-1',
      runId: 'run-side-effect',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
    }));

    const journal = recordSideEffect(createEmptySideEffectJournal(), started);
    expect(() => recordSideEffect(journal, {
      ...started,
      attemptId: createAttemptId(taskExecutionId, 2),
    })).toThrow(/idempotencyKey/);
  });

  it('rejects a same-key lifecycle record that drops lineage after it was declared', () => {
    const taskExecutionId = createTaskExecutionId('run-side-effect-drop', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const started = startSideEffect(createSideEffect({
      idempotencyKey: 'worker-execution:lineage-drop',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'input-1',
      runId: 'run-side-effect-drop',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
    }));

    const journal = recordSideEffect(createEmptySideEffectJournal(), started);
    expect(() => recordSideEffect(journal, {
      ...started,
      taskExecutionId: undefined,
      attemptId: undefined,
    })).toThrow(/idempotencyKey/);
  });

  it('preserves a malformed journal as needs-repair instead of returning an empty journal', () => {
    const parsed = parseSideEffectJournal('{"schemaVersion":1,"entries":[{"idempotencyKey":"broken"}]}');
    expect(parsed.status).toBe('needs-repair');
    expect(parsed.journal.entries).toHaveLength(0);

    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    return adapter.writeTextAtomic(repository.path, '{not-json').then(async () => {
      await expect(repository.record(planned)).rejects.toMatchObject({ code: 'needs-repair' });
    });
  });

  it('round-trips a valid journal through the adapter', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    await repository.record(planned);
    await repository.record(startSideEffect(planned));
    const raw = await adapter.readText(repository.path);
    expect(parseSideEffectJournal(raw).status).toBe('ok');
    expect(parseSideEffectJournal(raw).journal.entries).toHaveLength(1);
    expect(raw).toBe(serializeSideEffectJournal(parseSideEffectJournal(raw).journal));
  });
});
