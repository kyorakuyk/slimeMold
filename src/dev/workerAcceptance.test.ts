import { describe, expect, it, vi } from 'vitest';
import { EvidenceCollector } from './evidence';
import { createDevWorkerAcceptance } from './workerAcceptance';
import type { WorkerTaskLease } from '../domain/workerQueue';

type AcceptanceHost = Parameters<typeof createDevWorkerAcceptance>[0];
type TestHost = Omit<AcceptanceHost, 'service' | 'recordAcceptance'> & {
  service: {
    testRun: ReturnType<typeof vi.fn>;
    gitDiff: ReturnType<typeof vi.fn>;
    gitChangedFiles: ReturnType<typeof vi.fn>;
  };
  recordAcceptance: ReturnType<typeof vi.fn>;
};

const lease: WorkerTaskLease = {
  runId: 'run-1',
  orchestrationId: 'orch-1',
  task: {
    version: 1,
    id: 'task-1',
    architectureId: 'architecture-1',
    title: '实现任务',
    description: '完成实现',
    moduleId: 'module-1',
    scope: ['src/feature.ts'],
    dependsOn: [],
    acceptanceCriteria: ['测试通过'],
    category: 'implementation',
    status: 'approved',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  assignment: {
    worktreeId: 'worktree-1',
    path: 'C:/worktrees/task-1',
    branch: 'worker/task-1',
    baseRevision: 'base-1',
  },
  attempt: 1,
};

function host(overrides: Partial<TestHost> = {}): TestHost {
  return {
    policy: {
      allowedPaths: ['src'],
      protectedPaths: ['src/store/**'],
      requireApprovalFor: [],
      autoTest: true,
      autoCommit: false,
      autoPush: false,
    },
    service: {
      testRun: vi.fn(async () => ({ exitCode: 0, stdout: 'tests ok', stderr: '', durationMs: 10 })),
      gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
      gitChangedFiles: vi.fn(async () => ['src/feature.ts']),
    },
    collector: new EvidenceCollector(),
    nextAcceptanceId: vi.fn(() => 'acceptance-1'),
    recordAcceptance: vi.fn(),
    ...overrides,
  } as TestHost;
}

describe('createDevWorkerAcceptance', () => {
  it('runs host test/diff/path checks and returns persisted evidence ids on success', async () => {
    const deps = host();
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '模型报告已完成' } });

    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toHaveLength(3);
    expect(deps.service.testRun).toHaveBeenCalledWith(['npm', 'run', 'test'], { cwd: lease.assignment.path });
    expect(deps.service.gitDiff).toHaveBeenCalledWith('base-1', { cwd: lease.assignment.path });
    expect(deps.recordAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      acceptanceId: 'acceptance-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      passed: true,
      worktreePath: lease.assignment.path,
    }));
  });

  it('fails when tests fail or protected paths changed, regardless of model text', async () => {
    const deps = host({
      service: {
        testRun: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed', durationMs: 10 })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => ['src/store/workflowStore.ts']),
      },
    });
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '全部成功' } });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('tests');
    expect(result.failureReason).toContain('protected-paths');
    expect(deps.recordAcceptance).toHaveBeenCalledWith(expect.objectContaining({ passed: false }));
  });

  it('fails when there is no actual diff instead of accepting a no-op Worker', async () => {
    const deps = host({ service: {
      testRun: vi.fn(async () => ({ exitCode: 0, stdout: 'tests ok', stderr: '', durationMs: 10 })),
      gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })),
      gitChangedFiles: vi.fn(async () => []),
    } });
    const result = await createDevWorkerAcceptance(deps as unknown as AcceptanceHost).evaluate({ lease, response: { text: '完成' } });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('diff');
  });
});
