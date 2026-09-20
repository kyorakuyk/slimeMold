import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceRecord } from '../dev/session';
import type { SideEffectRecord } from '../domain/contracts';
import {
  createWorkerEvidenceRepositoryBundleFromModules,
  createWorkerHostRepositoryBundleFromModules,
  type WorkerEvidenceRepositoryModules,
  type WorkerHostRepositoryModules,
} from './workerHostRepositoryBundle';

const effect = { idempotencyKey: 'effect-1' } as SideEffectRecord;

function modules(trace: string[]) {
  let acceptanceLoad: (() => Promise<readonly AcceptanceRecord[]>) | undefined;
  let adapterCount = 0;
  const journal = {
    async read() {
      return { status: 'ok' as const, journal: { schemaVersion: 1 as const, entries: [effect] } };
    },
  };
  const full: WorkerHostRepositoryModules = {
    createTauriEventStoreAdapter: vi.fn(() => {
      trace.push(`adapter-${++adapterCount}`);
      return {} as never;
    }),
    createTauriEvidenceStore: vi.fn((root, workerRoot, source) => {
      trace.push(`evidence:${root}:${workerRoot}:${source}`);
      return {
        load: vi.fn(async () => []),
        append: vi.fn(async () => {}),
      };
    }),
    SideEffectJournalRepository: class {
      constructor() {
        trace.push('journal');
      }

      read = journal.read;
    } as never,
    createPersistedWorkerAcceptanceVerifier: vi.fn((persistence) => {
      trace.push('acceptance');
      acceptanceLoad = persistence.load;
      return { verify: vi.fn() } as never;
    }),
    createPersistedWorkerSideEffectRecorder: vi.fn(() => {
      trace.push('recorder');
      return { recoverInterruptedRun: vi.fn() } as never;
    }),
  };
  const evidence: WorkerEvidenceRepositoryModules = {
    createTauriEventStoreAdapter: full.createTauriEventStoreAdapter,
    createTauriEvidenceStore: full.createTauriEvidenceStore,
    SideEffectJournalRepository: full.SideEffectJournalRepository,
  };
  return { full, evidence, getAcceptanceLoad: () => acceptanceLoad };
}

describe('worker host repository bundles', () => {
  it('preserves full active bundle construction and read bridges', async () => {
    const trace: string[] = [];
    const fixture = modules(trace);
    const bundle = createWorkerHostRepositoryBundleFromModules(
      {
        projectPath: 'C:/project',
        listAcceptances: () => [],
      },
      fixture.full,
    );

    expect(trace).toEqual([
      'adapter-1',
      'journal',
      'evidence:C:/project/.slimemold/evidence:C:/project-workers:host',
      'acceptance',
      'recorder',
    ]);
    expect(await bundle.loadSideEffects()).toEqual([effect]);
    await bundle.loadEvidence();
    await fixture.getAcceptanceLoad()?.();
    expect(bundle.createEventRepository().eventsPath).toContain('.slimemold/events/events.jsonl');
    expect(trace).toContain('adapter-2');
  });

  it('keeps passive evidence bundle free of Acceptance/recorder construction', async () => {
    const trace: string[] = [];
    const fixture = modules(trace);
    const bundle = createWorkerEvidenceRepositoryBundleFromModules(
      { projectPath: 'C:/project' },
      fixture.evidence,
    );

    expect(trace).toEqual([
      'evidence:C:/project/.slimemold/evidence:C:/project-workers:host',
      'adapter-1',
      'journal',
    ]);
    await expect(bundle.loadSideEffects()).resolves.toEqual([effect]);
    expect(trace).not.toContain('acceptance');
    expect(trace).not.toContain('recorder');
  });

  it('propagates repository construction failure without a partial bundle', async () => {
    const failure = new Error('journal unavailable');
    const fixture = modules([]);
    const broken: WorkerHostRepositoryModules = {
      ...fixture.full,
      SideEffectJournalRepository: class {
        constructor() {
          throw failure;
        }
      } as never,
    };

    expect(() => createWorkerHostRepositoryBundleFromModules(
      { projectPath: 'C:/project', listAcceptances: () => [] },
      broken,
    )).toThrow(failure);
  });
});
