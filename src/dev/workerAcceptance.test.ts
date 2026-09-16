import { describe, expect, it, vi } from 'vitest';
import { EvidenceCollector, type EvidenceRecord } from './evidence';
import { createDevWorkerAcceptance } from './workerAcceptance';
import type { WorkerTaskLease } from '../domain/workerQueue';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

type AcceptanceHost = Parameters<typeof createDevWorkerAcceptance>[0];
type TestHost = Omit<AcceptanceHost, 'service' | 'recordAcceptance' | 'persistAcceptance'> & {
  service: {
    testRun: ReturnType<typeof vi.fn>;
    gitDiff: ReturnType<typeof vi.fn>;
    gitChangedFiles: ReturnType<typeof vi.fn>;
  };
  recordAcceptance: ReturnType<typeof vi.fn>;
  persistAcceptance: ReturnType<typeof vi.fn>;
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
  taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
  attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
};

function host(overrides: Partial<TestHost> = {}): TestHost {
  const persistedEvidence: EvidenceRecord[] = [];
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
    collector: new EvidenceCollector({
      append: async (record) => {
        persistedEvidence.push({ ...record });
      },
      load: async () => persistedEvidence.map((record) => ({ ...record })),
    }),
    nextAcceptanceId: vi.fn(() => 'acceptance-1'),
    recordAcceptance: vi.fn((record) => record),
    persistAcceptance: vi.fn(async () => {}),
    ...overrides,
  } as TestHost;
}

describe('createDevWorkerAcceptance', () => {
  it('runs host test/diff/path checks and returns persisted evidence ids on success', async () => {
    const deps = host();
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '模型报告已完成' } });

    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toHaveLength(4);
    expect(deps.collector.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskExecutionId: lease.taskExecutionId,
        attemptId: lease.attemptId,
      }),
    ]));
    expect(deps.service.testRun).toHaveBeenNthCalledWith(1, ['tsc', '--noEmit', '--target', 'es2020', 'src/feature.ts'], { cwd: lease.assignment.path });
    expect(deps.service.testRun).toHaveBeenNthCalledWith(2, ['tsc', '--noEmit', '--target', 'es2020', 'src/feature.ts'], { cwd: lease.assignment.path });
    expect(deps.service.gitDiff).toHaveBeenCalledWith('base-1', { cwd: lease.assignment.path });
    expect(deps.recordAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      acceptanceId: 'acceptance-1',
      orchestrationId: 'orch-1',
      stageId: 'task-1',
      passed: true,
      worktreePath: lease.assignment.path,
      taskExecutionId: lease.taskExecutionId,
      attemptId: lease.attemptId,
    }));
  });

  it('uses the task-owned stage for every Evidence and Acceptance record', async () => {
    const deps = host();
    const stageLease: WorkerTaskLease = {
      ...lease,
      task: { ...lease.task, stageId: 'verify' },
    };
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease: stageLease, response: { text: '完成' } });

    expect(result.passed).toBe(true);
    expect(deps.collector.records.every((record) => record.stageId === 'verify')).toBe(true);
    expect(deps.recordAcceptance).toHaveBeenCalledWith(expect.objectContaining({ stageId: 'verify' }));
  });

  it('uses the approved task scope for a disposable target instead of the host repository policy', async () => {
    const deps = host({
      service: {
        testRun: vi.fn(async () => ({ exitCode: 0, stdout: 'tests ok', stderr: '', durationMs: 10 })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => [
          'package.json',
          'server.mjs',
          'public/index.html',
          'src/main.js',
        ]),
      },
    });
    const scopedLease: WorkerTaskLease = {
      ...lease,
      task: {
        ...lease.task,
        scope: ['public/index.html', 'src/main.*', '本地 HTTP server 配置'],
      },
    };

    const result = await createDevWorkerAcceptance(deps as unknown as AcceptanceHost, {
      taskScopePolicy: true,
    }).evaluate({ lease: scopedLease, response: { text: '完成' } });

    expect(result.passed).toBe(true);
    expect(deps.service.testRun).toHaveBeenCalledTimes(2);
    expect(deps.service.testRun).toHaveBeenNthCalledWith(1, ['node', '--check', 'src/main.js'], { cwd: lease.assignment.path, pathPolicy: expect.any(Object) });
    expect(deps.service.testRun).toHaveBeenNthCalledWith(2, ['node', '--check', 'server.mjs'], { cwd: lease.assignment.path, pathPolicy: expect.any(Object) });
  });

  it('uses a scoped TypeScript check for an isolated TypeScript task', async () => {
    const deps = host({
      service: {
        testRun: vi.fn(async () => ({ exitCode: 0, stdout: 'tsc ok', stderr: '', durationMs: 10 })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => ['src/game/engine.ts', 'src/game/rules.ts']),
      },
    });
    const scopedLease: WorkerTaskLease = {
      ...lease,
      task: { ...lease.task, scope: ['src/game/engine.ts', 'src/game/rules.ts'] },
    };

    const result = await createDevWorkerAcceptance(deps as unknown as AcceptanceHost, {
      taskScopePolicy: true,
    }).evaluate({ lease: scopedLease, response: { text: '完成' } });

    expect(result.passed).toBe(true);
    expect(deps.service.testRun).toHaveBeenNthCalledWith(
      1,
      ['tsc', '--noEmit', '--target', 'es2020', 'src/game/engine.ts', 'src/game/rules.ts'],
      { cwd: lease.assignment.path, pathPolicy: expect.any(Object) },
    );
    expect(deps.service.testRun).toHaveBeenNthCalledWith(
      2,
      ['tsc', '--noEmit', '--target', 'es2020', 'src/game/engine.ts', 'src/game/rules.ts'],
      { cwd: lease.assignment.path, pathPolicy: expect.any(Object) },
    );
  });

  it('rejects protected changes before executing the host build/test oracle', async () => {
    const deps = host({
      policy: {
        allowedPaths: ['src', 'package.json'],
        protectedPaths: ['package.json'],
        requireApprovalFor: [],
        autoTest: true,
        autoCommit: false,
        autoPush: false,
      },
      service: {
        testRun: vi.fn(async () => ({ exitCode: 0, stdout: 'should not run', stderr: '', durationMs: 1 })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => ['package.json']),
      },
    });
    const result = await createDevWorkerAcceptance(deps as unknown as AcceptanceHost).evaluate({
      lease,
      response: { text: '模型报告已完成' },
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('受保护');
    expect(deps.service.testRun).not.toHaveBeenCalled();
    expect(result.evidenceIds).toHaveLength(1);
    expect(result.acceptanceId).toBe('acceptance-1');
    expect(deps.collector.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'path-policy', status: 'failed' }),
    ]));
    expect(deps.recordAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      passed: false,
      failedChecks: ['path-policy'],
    }));
  });

  it('fails when tests fail or protected paths changed, regardless of model text', async () => {
    const deps = host({
      service: {
        testRun: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed', durationMs: 10 })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn()
          .mockResolvedValueOnce(['src/feature.ts'])
          .mockResolvedValueOnce(['src/store/workflowStore.ts']),
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

  it('requires the host compile check before accepting a Worker result', async () => {
    const deps = host({
      service: {
        testRun: vi.fn(async (command: string[]) => ({
          exitCode: command[0] === 'tsc' ? 1 : 0,
          stdout: command[0] === 'tsc' ? '' : 'tests ok',
          stderr: command[0] === 'tsc' ? 'compile failed' : '',
          durationMs: 10,
        })),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => ['src/feature.ts']),
      },
    });
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '模型声称完成' } });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('compile');
    expect(deps.service.testRun).toHaveBeenCalledWith(['tsc', '--noEmit', '--target', 'es2020', 'src/feature.ts'], { cwd: lease.assignment.path });
  });

  it('rejects a forged lease lineage before running host checks', async () => {
    const deps = host();
    const forgedExecutionId = createTaskExecutionId('other-run', lease.task.id);
    const forgedLease = {
      ...lease,
      taskExecutionId: forgedExecutionId,
      attemptId: createAttemptId(forgedExecutionId, lease.attempt),
    };
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease: forgedLease, response: { text: '完成' } });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/lineage|execution|attempt/);
    expect(deps.service.testRun).not.toHaveBeenCalled();
  });

  it('rejects acceptance when the host has no durable Evidence persistence', async () => {
    const deps = host({ collector: new EvidenceCollector() });
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '完成' } });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/持久化|Evidence/);
    expect(deps.service.testRun).not.toHaveBeenCalled();
  });

  it('fails closed when acceptance persistence fails', async () => {
    const deps = host({
      persistAcceptance: vi.fn(async () => {
        throw new Error('acceptance disk unavailable');
      }),
    });
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    const result = await acceptance.evaluate({ lease, response: { text: '全部成功' } });

    expect(result.passed).toBe(false);
    expect(result.acceptanceId).toBeUndefined();
    expect(result.failureReason).toContain('acceptance disk unavailable');
  });

  it('stops host checks and persistence after operation cancellation', async () => {
    const controller = new AbortController();
    const deps = host({
      service: {
        testRun: vi.fn(async () => {
          controller.abort();
          return { exitCode: 0, stdout: 'tests ok', stderr: '', durationMs: 10 };
        }),
        gitDiff: vi.fn(async () => ({ exitCode: 0, stdout: 'diff', stderr: '', durationMs: 1 })),
        gitChangedFiles: vi.fn(async () => ['src/feature.ts']),
      },
    });
    const acceptance = createDevWorkerAcceptance(deps as unknown as AcceptanceHost);

    await expect(acceptance.evaluate({ lease, response: { text: '完成' }, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.service.gitDiff).not.toHaveBeenCalled();
    expect(deps.collector.records).toHaveLength(0);
    expect(deps.persistAcceptance).not.toHaveBeenCalled();
  });
});
