import { describe, it, expect } from 'vitest';
import { EvidenceCollector, createHostEvidenceStore, createHostEvidenceStoreWithFs, evidencePathFor, isMissingFileError, type EvidencePersistence } from './evidence';
import { withTestArtifactRoot } from './test-artifacts';
import { normalizeAbsolutePath } from './path-utils';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';

describe('H4 EvidenceCollector', () => {
  it('只把明确的 missing-file 错误视为缺失，不吞权限错误文本', () => {
    expect(isMissingFileError('dev_read_file: 文件不存在')).toBe(true);
    expect(isMissingFileError('permission denied: file not found')).toBe(false);
    expect(isMissingFileError(new Error('access denied: does not exist'))).toBe(false);
  });

  it('add 强制 capturedBy=host，并补齐 id/createdAt', () => {
    const c = new EvidenceCollector();
    const rec = c.add({
      orchestrationId: 'o1',
      stageId: 's1',
      kind: 'test',
      status: 'passed',
      exitCode: 0,
      summary: 'vitest 全绿',
    });
    expect(rec.capturedBy).toBe('host');
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeTruthy();
    // 即使输入伪造 capturedBy，也强制覆盖（类型不允许非 host，测试经 unknown 绕过类型检查）
    const fake = c.add({
      orchestrationId: 'o1',
      stageId: 's1',
      kind: 'test',
      status: 'passed',
      summary: 'x',
      capturedBy: 'agent',
    } as unknown as Parameters<EvidenceCollector['add']>[0]);
    expect(fake.capturedBy).toBe('host');
  });

  it('hasPersistence：未注入 false / 注入 true（forceCleanup 高风险操作前提）', () => {
    expect(new EvidenceCollector().hasPersistence()).toBe(false);
    const store = createHostEvidenceStore('/repo/.slimemold/evidence', '/repo/wt', 'k');
    expect(new EvidenceCollector(store).hasPersistence()).toBe(true);
  });

  it('rejects forged lineage when evidence declares execution identity', () => {
    const collector = new EvidenceCollector();
    expect(() => collector.add({
      orchestrationId: 'o1',
      stageId: 's1',
      kind: 'test',
      status: 'passed',
      summary: 'forged',
      runId: 'run-1',
      taskId: 'task-1',
      taskExecutionId: createTaskExecutionId('other-run', 'task-1'),
      attemptId: createAttemptId(createTaskExecutionId('other-run', 'task-1'), 1),
    })).toThrow(/lineage|execution|attempt/);
  });

  it('byStage 过滤、toJSON 快照、clear 清空', () => {
    const c = new EvidenceCollector();
    c.add({ orchestrationId: 'o1', stageId: 'a', kind: 'diff', status: 'passed', summary: 'd1' });
    c.add({ orchestrationId: 'o1', stageId: 'b', kind: 'diff', status: 'passed', summary: 'd2' });
    expect(c.byStage('a')).toHaveLength(1);
    const snap = c.toJSON();
    expect(snap).toHaveLength(2);
    c.clear();
    expect(c.records).toHaveLength(0);
  });

  it('P1 持久化：JSONL store 落盘 + loadPersisted 跨会话恢复（经宿主构造）', async () => {
    await withTestArtifactRoot('evidence', async (tmpRoot) => {
      const store = createHostEvidenceStore(tmpRoot, '/some/worktree', 'case');
      const c1 = new EvidenceCollector(store);
      await c1.addAsync({
        orchestrationId: 'o1',
        stageId: 's1',
        kind: 'test',
        status: 'passed',
        exitCode: 0,
        summary: 'first',
        runId: 'run-1',
        taskId: 'task-1',
        taskExecutionId: createTaskExecutionId('run-1', 'task-1'),
        attemptId: createAttemptId(createTaskExecutionId('run-1', 'task-1'), 1),
      });
      await c1.addAsync({ orchestrationId: 'o1', stageId: 's2', kind: 'diff', status: 'passed', summary: 'line one\nline two' });
      // 新 collector 从同一 store 恢复（模拟重启）
      const c2 = new EvidenceCollector(store);
      const loaded = await c2.loadPersisted();
      expect(loaded).toHaveLength(2);
      expect(loaded.every((r) => r.capturedBy === 'host')).toBe(true);
      const persistedTaskExecutionId = createTaskExecutionId('run-1', 'task-1');
      const persistedAttemptId = createAttemptId(persistedTaskExecutionId, 1);
      expect(loaded[0]).toMatchObject({ taskExecutionId: persistedTaskExecutionId, attemptId: persistedAttemptId });
      expect(c2.byScope({ taskExecutionId: persistedTaskExecutionId, attemptId: persistedAttemptId })).toHaveLength(1);
      expect(c2.records).toHaveLength(2);
    });
  });

  it('审计：evidencePathFor 拒绝路径逃逸 key；flush/addAsync 等待落盘确认', async () => {
    // 路径约束：合法 key → <baseDir>/<key>.jsonl；非法 key（分隔符/..）→ 抛错
    expect(evidencePathFor('/data/evidence', 'orch-20260812')).toBe(
      `${normalizeAbsolutePath('/data/evidence')}/orch-20260812.jsonl`,
    );
    expect(() => evidencePathFor('/data/evidence', '../etc/passwd')).toThrow(/非法证据存储 key/);
    expect(() => evidencePathFor('/data/evidence', 'a/b')).toThrow(/非法证据存储 key/);
    expect(() => evidencePathFor('/data/evidence', 'a\\b')).toThrow(/非法证据存储 key/);

    // P1：baseDir 与 worktree 相交 → 拒（EvidenceStore 必须在 worktree 外）
    expect(() => createHostEvidenceStore('/repo/worktree', '/repo/worktree', 'k')).toThrow(/worktree 之外/);
    expect(() => createHostEvidenceStore('/repo/worktree/.slimemold/evidence', '/repo/worktree', 'k')).toThrow(/worktree 之外/);
    expect(() => createHostEvidenceStore('/repo', '/repo/worktree', 'k')).toThrow(/worktree 之外/); // evidence 根是 worktree 祖先
    expect(() => createHostEvidenceStore('C:/Repo/Worktree/.slimemold/evidence', 'c:/repo/worktree', 'k')).toThrow(/worktree 之外/); // Windows 路径大小写不应绕过
    // P1（审计）：resolve 规范化后仍拒——折返路径 baseDir 实际落在 worktree 内
    expect(() => createHostEvidenceStore('/repo/worktree2/../worktree/evidence', '/repo/worktree', 'k')).toThrow(/worktree 之外/);
    // 合法：evidence 根在 worktree 外且不相交 → 返回持久化实例
    const ok = createHostEvidenceStore('/repo/.slimemold/evidence', '/repo/worktree', 'k1');
    expect(typeof ok.append).toBe('function');
    expect(typeof ok.load).toBe('function');

    // addAsync 等待落盘；flush 在落盘失败时 throw
    await withTestArtifactRoot('evidence-flush', async (flushRoot) => {
      const store = createHostEvidenceStore(flushRoot, '/some/worktree', 'case');
      const c = new EvidenceCollector(store);
      await c.addAsync({ orchestrationId: 'o1', stageId: 's1', kind: 'test', status: 'passed', exitCode: 0, summary: 'sync' });
      await c.flush(); // 无失败 → 不抛
      expect(c.records).toHaveLength(1);

      // 落盘失败（mock persistence reject）→ flush throw（含证据 id 与失败原因），验收据此拒绝
      const c2 = new EvidenceCollector({
        append: async () => {
          throw new Error('disk full');
        },
        load: async () => [],
      });
      c2.add({ orchestrationId: 'o1', stageId: 's1', kind: 'test', status: 'passed', summary: 'x' });
      await expect(c2.flush()).rejects.toThrow(/证据.*落盘失败/);
    });
  });

  it('does not turn evidence read failures into an empty successful load', async () => {
    const store = createHostEvidenceStoreWithFs(
      '/repo/evidence',
      '/repo-workers/run-1/task-1',
      'records',
      {
        mkdir: async () => {},
        append: async () => {},
        read: async () => {
          throw new Error('permission denied');
        },
      },
    );

    await expect(store.load()).rejects.toThrow();
  });

  it('rejects conflicting duplicate Evidence IDs during restart load', async () => {
    const source = new EvidenceCollector();
    const original = source.add({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'passed',
      summary: 'original',
    });
    const restored = new EvidenceCollector({
      append: async () => {},
      load: async () => [original, { ...original, summary: 'tampered' }],
    });

    await expect(restored.loadPersisted()).rejects.toThrow(/Evidence ID 内容冲突/);
    expect(restored.records).toHaveLength(0);
  });

  it('removes pending evidence from memory when durable append fails', async () => {
    const collector = new EvidenceCollector({
      append: async () => { throw new Error('disk unavailable'); },
      load: async () => [],
    });
    await expect(collector.addAsync({ orchestrationId: 'o', stageId: 's', kind: 'test', status: 'failed', summary: 'x' })).rejects.toThrow();
    expect(collector.records).toHaveLength(0);
  });

  it('rejects an append that does not read back the exact Evidence record', async () => {
    const collector = new EvidenceCollector({
      append: async () => {},
      load: async () => [],
    });

    await expect(collector.addAsync({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'passed',
      summary: 'append silently dropped',
    })).rejects.toThrow(/read-back|持久化/);
    expect(collector.records).toHaveLength(0);
  });

  it('rolls back when persistence append throws synchronously', async () => {
    const collector = new EvidenceCollector({
      append: (() => { throw new Error('sync append failure'); }) as unknown as EvidencePersistence['append'],
      load: async () => [],
    });

    await expect(collector.addAsync({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'failed',
      summary: 'sync failure',
    })).rejects.toThrow('sync append failure');
    expect(collector.records).toHaveLength(0);
  });

  it('captures synchronous fire-and-forget append failures for flush', async () => {
    const collector = new EvidenceCollector({
      append: (() => { throw new Error('sync fire-and-forget failure'); }) as unknown as EvidencePersistence['append'],
      load: async () => [],
    });

    expect(() => collector.add({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'failed',
      summary: 'sync fire-and-forget',
    })).not.toThrow();
    await expect(collector.flush()).rejects.toThrow(/sync fire-and-forget failure/);
    expect(collector.records).toHaveLength(0);
  });

  it('rejects read-back with duplicate records for the newly written Evidence ID', async () => {
    let appended: import('./evidence').EvidenceRecord | undefined;
    const collector = new EvidenceCollector({
      append: async (record) => {
        appended = record;
      },
      load: async () => (appended ? [appended, { ...appended }] : []),
    });

    await expect(collector.addAsync({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'passed',
      summary: 'duplicate read-back',
    })).rejects.toThrow(/read-back/);
    expect(collector.records).toHaveLength(0);
  });

  it('flush waits for the complete append and read-back verification', async () => {
    let releaseLoad!: () => void;
    let resolveLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => { resolveLoadStarted = resolve; });
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let appended: import('./evidence').EvidenceRecord | undefined;
    const collector = new EvidenceCollector({
      append: async (record) => {
        appended = record;
      },
      load: async () => {
        resolveLoadStarted();
        await loadGate;
        return appended ? [appended] : [];
      },
    });

    const adding = collector.addAsync({
      orchestrationId: 'o',
      stageId: 's',
      kind: 'test',
      status: 'passed',
      summary: 'deferred read-back',
    });
    await loadStarted;
    let flushed = false;
    const flushing = collector.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    releaseLoad();
    await Promise.all([adding, flushing]);
  });
});
