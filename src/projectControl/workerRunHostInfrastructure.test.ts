import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceRecord } from '../dev/session';
import type { SideEffectRecord } from '../domain/contracts';
import {
  createWorkerRunHostInfrastructure,
  type WorkerRunHostInfrastructureModules,
} from './workerRunHostInfrastructure';

const sideEffect = { idempotencyKey: 'effect-1' } as SideEffectRecord;

function moduleLoader(trace: string[], readEntries: readonly SideEffectRecord[] = []) {
  let acceptanceLoad: (() => Promise<readonly AcceptanceRecord[]>) | undefined;
  let adapterCalls = 0;
  const sideEffectRepository = {
    async read() {
      return { status: 'ok' as const, journal: { schemaVersion: 1 as const, entries: [...readEntries] } };
    },
  };
  const modules: WorkerRunHostInfrastructureModules = {
    createTauriEventStoreAdapter: vi.fn(() => {
      trace.push(`event-adapter-${++adapterCalls}`);
      return {} as never;
    }),
    createTauriEvidenceStore: vi.fn((evidenceRoot, workerRoot, source) => {
      trace.push(`evidence:${evidenceRoot}:${workerRoot}:${source}`);
      return {
        load: vi.fn(async () => []),
        append: vi.fn(async () => {}),
      };
    }),
    SideEffectJournalRepository: class {
      constructor(_adapter: unknown, root: string) {
        trace.push(`side-effect-repository:${root}`);
      }

      read = sideEffectRepository.read;
    } as never,
    createPersistedWorkerAcceptanceVerifier: vi.fn((persistence) => {
      trace.push('acceptance-verifier');
      acceptanceLoad = persistence.load;
      return { verify: vi.fn() } as never;
    }),
    createPersistedWorkerSideEffectRecorder: vi.fn(() => {
      trace.push('side-effect-recorder');
      return { claim: vi.fn() } as never;
    }),
  };
  return {
    modules,
    loader: async () => modules,
    getAcceptanceLoad: () => acceptanceLoad,
  };
}

describe('createWorkerRunHostInfrastructure', () => {
  it('constructs the exact repositories and live Acceptance closure in order', async () => {
    const trace: string[] = [];
    const fixture = moduleLoader(trace, [sideEffect]);
    const acceptances = [{ id: 'acceptance-1' } as unknown as AcceptanceRecord];
    const assertOperation = vi.fn(() => trace.push('assert-operation'));

    const infrastructure = await createWorkerRunHostInfrastructure(
      {
        projectPath: 'C:/project',
        listAcceptances: () => {
          trace.push('list-acceptances');
          return acceptances;
        },
        assertOperation,
      },
      fixture.loader,
    );

    expect(trace).toEqual([
      'event-adapter-1',
      'side-effect-repository:C:/project',
      'evidence:C:/project/.slimemold/evidence:C:/project-workers:host',
      'acceptance-verifier',
      'side-effect-recorder',
      'assert-operation',
      'event-adapter-2',
    ]);
    expect(fixture.modules.createTauriEventStoreAdapter).toHaveBeenCalledTimes(2);
    expect(infrastructure.eventRepository.eventsPath).toBe('C:/project/.slimemold/events/events.jsonl');
    expect(infrastructure.eventRepository.snapshotPath).toBe('C:/project/.slimemold/snapshots/project-state.json');
    expect(await infrastructure.loadSideEffects()).toEqual([sideEffect]);
    await fixture.getAcceptanceLoad()?.();
    expect(trace).toContain('list-acceptances');
  });

  it('propagates a construction failure without creating a fallback repository', async () => {
    const constructionFailure = new Error('side-effect repository unavailable');
    const assertOperation = vi.fn();
    const loader = async () => {
      throw constructionFailure;
    };

    await expect(createWorkerRunHostInfrastructure(
      {
        projectPath: 'C:/project',
        listAcceptances: () => [],
        assertOperation,
      },
      loader,
    )).rejects.toBe(constructionFailure);
    expect(assertOperation).not.toHaveBeenCalled();
  });

  it('fences before EventStream construction and does not return partial infrastructure', async () => {
    const trace: string[] = [];
    const fixture = moduleLoader(trace);
    const guardFailure = new Error('operation changed');
    const assertOperation = vi.fn(() => {
      trace.push('assert-operation');
      throw guardFailure;
    });

    await expect(createWorkerRunHostInfrastructure(
      {
        projectPath: 'C:/project',
        listAcceptances: () => [],
        assertOperation,
      },
      fixture.loader,
    )).rejects.toBe(guardFailure);
    expect(fixture.modules.createTauriEventStoreAdapter).toHaveBeenCalledTimes(1);
    expect(trace).not.toContain('event-adapter-2');
  });
});
