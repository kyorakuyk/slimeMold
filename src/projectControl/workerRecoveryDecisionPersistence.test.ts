import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import { InMemoryEventStoreAdapter } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import {
  WorkerRecoveryDecisionCasError,
  WorkerRecoveryDecisionPersistence,
} from './workerRecoveryDecisionPersistence';

const factsFingerprint = (hex: string): string => `worker-recovery-facts-v1:sha256:${hex.repeat(64)}`;

function candidate(decision: 'retry' | 'skip' = 'retry', decisionId = 'decision-1') {
  return {
    taskGraphTaskIds: [],
    state: {
      version: 1,
      projectId: 'project-1',
      runId: 'run-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      tasks: {},
    } satisfies WorkerRunQueueState,
    events: [{
      eventId: `${decisionId}:WorkerRunRecoveryDecided:run-1`,
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Run',
      aggregateId: 'run-1',
      aggregateVersion: 1,
      eventType: 'WorkerRunRecoveryDecided',
      schemaVersion: 1,
      payload: { runId: 'run-1', decision },
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
    factsFingerprint: factsFingerprint('a'),
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
      { readCurrentFactsFingerprint: async () => factsFingerprint('b') },
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
      readCurrentFactsFingerprint: async () => factsFingerprint('c'),
      isCandidateApplied: async () => true,
    })).resolves.toMatchObject({ kind: 'replay', record: { status: 'committed' } });
  });

  it('resumes a committed request when its durable candidate is missing from the projection', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });
    await persistence.commit(exact);

    await expect(persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
      isCandidateApplied: async () => false,
    })).resolves.toMatchObject({ kind: 'resume', record: { status: 'committed' } });
  });

  it('tracks retry post-commit dispatch and reads the status back durably', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });
    await expect(persistence.commit(exact)).resolves.toMatchObject({
      status: 'committed',
      postCommitStatus: 'pending',
    });
    await expect(persistence.markPostCommit(exact, 'dispatching', exact.now)).resolves.toMatchObject({
      postCommitStatus: 'dispatching',
    });
    await expect(persistence.markPostCommit(exact, 'completed', exact.now)).resolves.toMatchObject({
      postCommitStatus: 'completed',
    });
    await expect(persistence.markPostCommit(exact, 'failed', exact.now)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(persistence.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ postCommitStatus: 'completed' })] },
    });
  });

  it('rechecks the projection under the durable commit lock', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await persistence.admit(exact, {
      readCurrentFactsFingerprint: async () => exact.factsFingerprint,
    });

    await expect(persistence.commit(exact, {
      verifyProjection: async () => false,
    })).rejects.toMatchObject({ code: 'needs-repair' });
    await expect(persistence.read()).resolves.toMatchObject({
      journal: { entries: [expect.objectContaining({ status: 'admitted' })] },
    });
    await expect(persistence.commit(exact, {
      verifyProjection: async () => true,
    })).resolves.toMatchObject({ status: 'committed' });
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
      factsFingerprint: factsFingerprint('d'),
      candidate: candidate('skip'),
    }, {
      readCurrentFactsFingerprint: async () => factsFingerprint('d'),
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
      candidate: candidate('retry', 'decision-2'),
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

  it('rejects a durable candidate with an invalid run state before admission', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await adapter.writeTextAtomic(persistence.path, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        ...exact,
        status: 'admitted',
        admittedAt: exact.now,
        candidate: {
          ...exact.candidate,
          state: { ...exact.candidate.state, status: 'not-a-worker-run-status' },
        },
      }],
    }));

    await expect(persistence.read()).resolves.toMatchObject({ status: 'needs-repair' });
  });

  it('rejects a durable candidate whose attempt has no execution lineage', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await adapter.writeTextAtomic(persistence.path, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        ...exact,
        status: 'admitted',
        admittedAt: exact.now,
        candidate: {
          ...exact.candidate,
          state: {
            ...exact.candidate.state,
            tasks: {
              'task-1': {
                taskId: 'task-1',
                status: 'failed',
                attempt: 1,
                evidenceIds: [],
                updatedAt: exact.now,
              },
            },
          },
        },
      }],
    }));

    await expect(persistence.read()).resolves.toMatchObject({ status: 'needs-repair' });
  });

  it('rejects an empty mutating recovery candidate event set', async () => {
    const adapter = new InMemoryEventStoreAdapter();
    const persistence = new WorkerRecoveryDecisionPersistence(adapter, 'project-1');
    const exact = input();
    await adapter.writeTextAtomic(persistence.path, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        ...exact,
        status: 'admitted',
        admittedAt: exact.now,
        candidate: { ...exact.candidate, events: [] },
      }],
    }));

    await expect(persistence.read()).resolves.toMatchObject({ status: 'needs-repair' });
  });
});
