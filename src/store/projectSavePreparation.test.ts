import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedEventStream } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { Orchestration } from '../types/orchestration';
import {
  restoreMissingWorkerRunsFromEvents,
} from '../projectControl/workerRunRehydration';
import { projectWorkerRunsOntoOrchestrations } from '../projectControl/workerRunOrchestrationProjection';
import {
  createProjectSavePreparation,
  type ProjectSavePreparationState,
} from './projectSavePreparation';

vi.mock('../projectControl/workerRunRehydration', () => ({
  restoreMissingWorkerRunsFromEvents: vi.fn(),
}));
vi.mock('../projectControl/workerRunOrchestrationProjection', () => ({
  projectWorkerRunsOntoOrchestrations: vi.fn(),
}));

interface TestState extends ProjectSavePreparationState {
  projectControl: { taskGraphs: [] };
}

function createState(): TestState {
  return {
    projectId: 'project-1',
    projectPath: 'C:/project',
    projectCreatedAt: '2026-09-01T00:00:00.000Z',
    projectDirty: true,
    lastSavedSnapshot: 'old',
    workerRuns: [],
    orchestrations: [],
    projectControl: { taskGraphs: [] },
  };
}

function eventStream(overrides: Partial<ParsedEventStream> = {}): ParsedEventStream {
  return {
    status: 'ok',
    events: [],
    lastSequence: 0,
    ...overrides,
  };
}

describe('project save preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips event-stream reads outside Tauri or when the projection already exists', async () => {
    const state = createState();
    const readEventStream = vi.fn(async () => eventStream());
    const preparation = createProjectSavePreparation<TestState>({
      isTauri: false,
      getState: () => state,
      setState: vi.fn(),
      readEventStream,
    });

    await preparation.prepareForSave();

    expect(readEventStream).not.toHaveBeenCalled();
  });

  it('skips event-stream reads when the projection already exists', async () => {
    const state = createState();
    state.workerRuns = [{ runId: 'run-1' } as WorkerRunQueueState];
    const readEventStream = vi.fn(async () => eventStream());
    const preparation = createProjectSavePreparation<TestState>({
      isTauri: true,
      getState: () => state,
      setState: vi.fn(),
      readEventStream,
    });

    await preparation.prepareForSave();

    expect(readEventStream).not.toHaveBeenCalled();
  });

  it('restores a missing projection and reprojects linked orchestrations', async () => {
    const state = createState();
    const setState = vi.fn();
    const restoredRun = { runId: 'run-1' } as WorkerRunQueueState;
    const projected = [{ id: 'orch-1' }] as Orchestration[];
    vi.mocked(restoreMissingWorkerRunsFromEvents).mockReturnValue({
      restored: true,
      runs: [restoredRun],
      issues: [],
    });
    vi.mocked(projectWorkerRunsOntoOrchestrations).mockReturnValue(projected);
    const preparation = createProjectSavePreparation<TestState>({
      isTauri: true,
      getState: () => state,
      setState,
      readEventStream: vi.fn(async () => eventStream()),
    });

    await preparation.prepareForSave();

    expect(setState).toHaveBeenCalledWith({
      workerRuns: [restoredRun],
      orchestrations: projected,
    });
    expect(restoreMissingWorkerRunsFromEvents).toHaveBeenCalledWith({
      projectId: 'project-1',
      events: [],
      taskGraphs: [],
      existingRuns: [],
    });
  });

  it('blocks saving when the event stream needs repair', async () => {
    const state = createState();
    const preparation = createProjectSavePreparation<TestState>({
      isTauri: true,
      getState: () => state,
      setState: vi.fn(),
      readEventStream: vi.fn(async () => eventStream({
        status: 'needs-repair',
        corruption: {
          line: 4,
          raw: '{bad',
          tail: '',
          reason: 'invalid JSON',
        },
      })),
    });

    await expect(preparation.prepareForSave()).rejects.toThrow(
      'Worker 事件流需要修复：第 4 行 invalid JSON',
    );
  });
});
