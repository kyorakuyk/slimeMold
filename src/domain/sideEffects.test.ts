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

class SilentDropEventStoreAdapter extends InMemoryEventStoreAdapter {
  override async writeTextAtomic(): Promise<void> {
    // Simulate an adapter that reports success without making the journal durable.
  }
}

class DelayedWriteEventStoreAdapter extends InMemoryEventStoreAdapter {
  readonly events: string[] = [];
  private readonly gate: Promise<void>;
  private releaseWrite!: () => void;

  constructor() {
    super();
    this.gate = new Promise<void>((resolve) => {
      this.releaseWrite = resolve;
    });
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.events.push('write-start');
    await this.gate;
    this.events.push('write-done');
    await super.writeTextAtomic(path, text);
  }

  async acquireLock(path: string) {
    const lock = await super.acquireLock(path);
    return {
      release: async () => {
        this.events.push('release');
        await lock.release();
      },
    };
  }

  finishWrite(): void {
    this.releaseWrite();
  }
}

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

  it('atomically claims one execution across concurrent callers', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'project-root');
    const started = startSideEffect(planned);
    const [first, second] = await Promise.all([
      repository.claim(started),
      repository.claim(started),
    ]);
    expect([first, second].filter((result) => result.claimed)).toHaveLength(1);
    expect((await repository.read()).journal.entries).toEqual([started]);
  });

  it('fails closed when a journal write is silently dropped', async () => {
    const repository = new SideEffectJournalRepository(new SilentDropEventStoreAdapter(), 'project-root');

    await expect(repository.record(planned)).rejects.toThrow(/read-back|durable|持久化/);
  });

  it('keeps the journal lock until write and read-back finish', async () => {
    const adapter = new DelayedWriteEventStoreAdapter();
    const repository = new SideEffectJournalRepository(adapter, 'project-root');
    const pending = repository.record(planned);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    adapter.finishWrite();
    await pending;
    expect(adapter.events).toEqual(['write-start', 'write-done', 'release']);
  });

  it('rejects migration when legacy and replacement keys are identical', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'project-root');
    await repository.record(planned);

    await expect(repository.migrateLegacyRecord(planned.idempotencyKey, planned)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await repository.read()).journal.entries).toEqual([planned]);
  });

  it('rejects canonical and legacy alias records coexisting for one effect', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'project-root');
    const taskExecutionId = createTaskExecutionId('run-alias', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const canonical = createSideEffect({
      idempotencyKey: 'worker-execution:canonical',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'canonical-input',
      runId: 'run-alias',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
    });
    const legacy = createSideEffect({
      idempotencyKey: 'worker-execution:legacy',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'legacy-input',
      runId: 'run-alias',
      taskId: 'task-1',
    });
    await repository.record(canonical);
    await repository.record(legacy);

    await expect(repository.claim(startSideEffect(canonical), [legacy]))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a legacy alias without complete lineage before upgrading it', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'project-root');
    const taskExecutionId = createTaskExecutionId('run-legacy', 'task-1');
    const attemptId = createAttemptId(taskExecutionId, 1);
    const canonical = createSideEffect({
      idempotencyKey: 'worker-execution:canonical-legacy',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'canonical-input',
      runId: 'run-legacy',
      taskId: 'task-1',
      taskExecutionId,
      attemptId,
    });
    const legacy = createSideEffect({
      idempotencyKey: 'worker-execution:legacy-only',
      kind: 'worker-execution',
      target: 'worktree-1',
      inputHash: 'legacy-input',
      runId: 'run-legacy',
      taskId: 'task-1',
    });
    await repository.record(legacy);

    await expect(repository.claim(startSideEffect(canonical), [legacy]))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.read()).journal.entries[0].status).toBe('planned');
    expect(attemptId).toBeTruthy();
  });

  it('rejects malformed receipt before it can reach the journal', async () => {
    const repository = new SideEffectJournalRepository(new InMemoryEventStoreAdapter(), 'project-root');
    await expect(repository.record({
      ...planned,
      status: 'receipt',
      recovery: 'skip',
      receipt: { receiptId: 'r', observedAt: 'now' },
    })).rejects.toThrow(/outcome/);
    expect((await repository.read()).journal.entries).toHaveLength(0);
  });

  it('rejects a delivery receipt containing a path traversal', () => {
    const parsed = parseSideEffectJournal(JSON.stringify({
      schemaVersion: 1,
      entries: [{
        ...planned,
        kind: 'artifact-delivery',
        status: 'receipt',
        recovery: 'skip',
        receipt: {
          receiptId: 'delivery:receipt',
          observedAt: '2026-09-04T00:00:00.000Z',
          outcome: 'succeeded',
          artifactCandidateId: 'candidate-1',
          approvalId: 'approval-1',
          outputHash: 'h1',
          files: [{ path: '../escape.ts', contentHash: 'h2' }],
        },
      }],
    }));
    expect(parsed.status).toBe('needs-repair');
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

  it('keeps an interrupted effect unknown and rejects a late receipt', () => {
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
    expect(journal.entries[0]).toMatchObject({ status: 'unknown', recovery: 'needs-user', receipt: undefined });
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
