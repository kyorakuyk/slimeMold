import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import {
  WorkerRecoveryDecisionCasError,
  WorkerRecoveryDecisionPersistence,
} from './workerRecoveryDecisionPersistence';

function candidate() {
  return {
    state: { runId: 'run-1', status: 'queued' } as unknown as WorkerRunQueueState,
    events: [{
      eventId: 'decision-1:WorkerRunRecoveryDecided:run-1',
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Run',
      aggregateId: 'run-1',
      aggregateVersion: 1,
      eventType: 'WorkerRunRecoveryDecided',
      schemaVersion: 1,
      payload: { runId: 'run-1', decision: 'retry' },
      actor: 'user',
      occurredAt: '2026-09-22T00:00:00.000Z',
      correlationId: 'run-1',
      source: { objectId: 'graph-1', objectVersion: 1 },
      sensitivity: 'normal',
    } satisfies DomainEvent],
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    requestIdentity: 'request-1',
    action: 'retry' as const,
    semanticPayloadVersion: 1 as const,
    decisionId: 'decision-1',
    factsFingerprint: 'worker-recovery-facts-v1:sha256:captured',
    candidate: candidate(),
    now: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('WorkerRecoveryDecisionPersistence', () => {
  it('rejects a stale captured fingerprint before writing an admission', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');

    await expect(persistence.admit(
      input(),
      { readCurrentFactsFingerprint: async () => 'worker-recovery-facts-v1:sha256:fresh' },
    )).rejects.toMatchObject({ code: 'stale' });
    await expect(persistence.read()).resolves.toMatchObject({ status: 'empty' });
  });

  it('durably admits, commits, and replays an exact request after a repository restart', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const first = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    const fresh = { readCurrentFactsFingerprint: async () => exact.factsFingerprint };

    await expect(first.admit(exact, fresh)).resolves.toMatchObject({ kind: 'admitted' });
    await expect(first.commit(exact)).resolves.toMatchObject({ status: 'committed' });

    const restarted = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    await expect(restarted.admit(exact, {
      readCurrentFactsFingerprint: async () => 'worker-recovery-facts-v1:sha256:post-commit',
    })).resolves.toMatchObject({ kind: 'replay', record: { status: 'committed' } });
  });

  it('resumes an admitted request with its durable candidate after a restart', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const first = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await first.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });

    const restarted = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    await expect(restarted.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    })).resolves.toMatchObject({ kind: 'resume', record: { status: 'admitted' } });
  });

  it('fails closed on a same request identity with changed facts or action', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });

    await expect(persistence.admit({
      ...exact,
      action: 'skip',
      factsFingerprint: 'worker-recovery-facts-v1:sha256:other',
      candidate: candidate(),
    }, {
      readCurrentFactsFingerprint: async () => 'worker-recovery-facts-v1:sha256:other',
    })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a second request for the same run facts and action', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });

    await expect(persistence.admit({
      ...exact,
      requestIdentity: 'request-2',
      decisionId: 'decision-2',
    }, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not silently overwrite a malformed durable decision journal', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    await adapter.writeTextAtomic(persistence.path, '{broken');

    await expect(persistence.admit(input(), {
      readCurrentFactsFingerprint: async () => input().factsFingerprint,
    })).rejects.toMatchObject({ code: 'needs-repair' });
    expect(persistence).toBeInstanceOf(WorkerRecoveryDecisionPersistence);
    expect(WorkerRecoveryDecisionCasError).toBeDefined();
  });
});
