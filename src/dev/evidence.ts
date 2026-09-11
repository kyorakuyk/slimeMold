/**
 * H4 证据模型（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §4）。
 *
 * StageLog 回答「阶段运行到什么状态」，EvidenceLog 回答「系统有什么客观证据证明阶段完成」——
 * 两者职责分离。关键约束：capturedBy 恒为 'host'，Agent（模型/工作流节点）不能自报事实证据，
 * 只能写 uncertainties/agentSummary 辅助文本。
 */
import { normalizeAbsolutePath, pathComparisonKey, pathsOverlap } from './path-utils';
import { assertTaskExecutionLineage } from '../domain/execution';

export type EvidenceKind = 'command' | 'test' | 'diff' | 'path-policy' | 'artifact';

export type EvidenceStatus = 'passed' | 'failed' | 'unknown';

export interface EvidenceRecord {
  id: string;
  orchestrationId: string;
  stageId: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  /** 被采集的命令（command/test 类；如 "tsc --noEmit"，用于规则匹配） */
  command?: string;
  /** 命令退出码（command/test 类；宿主采集，非 Agent 自报） */
  exitCode?: number;
  /** 宿主生成的一句话摘要 */
  summary: string;
  /** 强制：仅宿主采集，Agent 不可自报 */
  capturedBy: 'host';
  /** 当前 Worker execution lineage；旧证据可能没有这些字段。 */
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
  worktreePath?: string;
  baseRevision?: string;
  headRevision?: string;
  contentHash?: string;
  createdAt: string;
}

export function decodeEvidenceRecord(value: unknown): EvidenceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Evidence 记录必须是对象');
  }
  const record = value as Partial<EvidenceRecord>;
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('Evidence.id 无效');
  if (typeof record.orchestrationId !== 'string' || !record.orchestrationId.trim()) throw new Error('Evidence.orchestrationId 无效');
  if (typeof record.stageId !== 'string' || !record.stageId.trim()) throw new Error('Evidence.stageId 无效');
  if (!['command', 'test', 'diff', 'path-policy', 'artifact'].includes(record.kind as string)) throw new Error('Evidence.kind 无效');
  if (!['passed', 'failed', 'unknown'].includes(record.status as string)) throw new Error('Evidence.status 无效');
  if (typeof record.summary !== 'string' || !record.summary.trim()) throw new Error('Evidence.summary 无效');
  if (record.capturedBy !== 'host') throw new Error('Evidence.capturedBy 必须是 host');
  if (typeof record.createdAt !== 'string' || !record.createdAt.trim()) throw new Error('Evidence.createdAt 无效');
  for (const key of ['command', 'worktreePath', 'baseRevision', 'headRevision', 'contentHash'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key].trim())) {
      throw new Error(`Evidence.${key} 无效`);
    }
  }
  if (record.exitCode !== undefined && (!Number.isSafeInteger(record.exitCode))) throw new Error('Evidence.exitCode 无效');
  const lineageKeys = [record.runId, record.taskId, record.taskExecutionId, record.attemptId];
  if (lineageKeys.some((item) => item !== undefined)) {
    if (lineageKeys.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Evidence lineage 不完整');
    const [runId, taskId, taskExecutionId, attemptId] = lineageKeys as [string, string, string, string];
    assertTaskExecutionLineage({
      runId,
      taskId,
      taskExecutionId,
      attemptId,
    });
  }
  return { ...record } as EvidenceRecord;
}

/** 确定性验收结论（由 DevEvaluator 依据规则 + 证据生成）。 */
export interface DevAcceptance {
  passed: boolean;
  requiredChecks: string[];
  failedChecks: string[];
  changedProtectedPaths: string[];
  /** 模型只能写这里，不能写事实证据 */
  uncertainties: string[];
}

/** 新增证据的输入（id/createdAt/capturedBy 由宿主补齐）。 */
export type EvidenceInput = Omit<EvidenceRecord, 'id' | 'createdAt' | 'capturedBy'>;

let seq = 0;
function nextId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `ev-${uuid}`;
  seq += 1;
  return `ev-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Evidence 持久化接口：宿主独占落盘（EvidenceStore 必须位于 worktree 之外）。
 * append 在 add 时调用；load 用于启动/恢复跨会话审计。
 */
export interface EvidencePersistence {
  append(rec: EvidenceRecord): Promise<void>;
  load(): Promise<EvidenceRecord[]>;
}

/**
 * 宿主统一约束的 EvidenceStore 路径（审计修复）：
 * - baseDir 由宿主指定（如 `<项目根>/.slimemold/evidence/`，位于 worktree 之外）；
 * - key 只允许 `[a-zA-Z0-9._-]`，**拒绝任何路径分隔符与 `..`**（防 `../` 逃逸到任意目录）；
 * - 返回 `<baseDir>/<key>.jsonl` 绝对路径（baseDir 经 resolve 规范化）。
 */
export function evidencePathFor(baseDir: string, key: string): string {
  if (!/^[\w.-]+$/.test(key) || key.includes('..')) {
    throw new Error(`非法证据存储 key：${key}（仅允许 [a-zA-Z0-9._-]，禁止路径分隔符/..）`);
  }
  return `${normalizeAbsolutePath(baseDir)}/${key}.jsonl`;
}

/**
 * 校验 baseDir 与 worktree 路径不相交（P1 审计修复）：
 * 统一经 resolve 规范化（解析 . / ..），防 `/repo/worktree2/../worktree/evidence`
 * 这类折返绕过；任一方是另一方祖先/等价 → 拒绝。
 */
export function assertEvidenceOutsideWorktree(baseDir: string, worktreePath: string): void {
  const b = normalizeAbsolutePath(baseDir);
  const w = normalizeAbsolutePath(worktreePath);
  if (pathsOverlap(baseDir, worktreePath)) {
    throw new Error(`EvidenceStore 必须位于 worktree 之外：baseDir=${b}，worktree=${w}`);
  }
}

/**
 * 宿主构造 EvidenceStore（P1 审计修复）：
 * - 不接受 Agent 提供的任意 baseDir——由宿主传入证据根（如 `.slimemold/evidence`）与 worktreePath；
 * - 校验二者不相交（assertEvidenceOutsideWorktree）+ key 合法（evidencePathFor）；
 * - 返回 JSONL 持久化实例（Node 版默认；Tauri 走 createHostEvidenceStoreWithFs）。
 */
export function createHostEvidenceStore(
  evidenceRoot: string,
  worktreePath: string,
  key: string,
): EvidencePersistence {
  return createHostEvidenceStoreWithFs(evidenceRoot, worktreePath, key, createNodeJsonlFs());
}

/**
 * 宿主构造 EvidenceStore（注入 JsonlFsOps——Tauri GUI 用 plugin-fs）。
 * 与 createHostEvidenceStore 相同的断言约束；fs 实现由调用方（宿主）注入。
 */
export function createHostEvidenceStoreWithFs(
  evidenceRoot: string,
  worktreePath: string,
  key: string,
  fsOps: JsonlFsOps,
): EvidencePersistence {
  assertEvidenceOutsideWorktree(evidenceRoot, worktreePath);
  return createJsonlEvidenceStore(evidencePathFor(evidenceRoot, key), fsOps);
}

/** JSONL 底层文件操作抽象：Node（headless）与 Tauri（GUI）各自注入实现。 */
export interface JsonlFsOps {
  mkdir(dir: string): Promise<void>;
  append(abs: string, text: string): Promise<void>;
  read(abs: string): Promise<string>;
}

/** Node 版 JsonlFsOps（headless/CI，动态 import node:fs；GUI 走 Tauri 通道不会调用）。 */
export function createNodeJsonlFs(): JsonlFsOps {
  return {
    mkdir: async (dir) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
    },
    append: async (abs, text) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(abs, text, 'utf8');
    },
    read: async (abs) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(abs, 'utf8');
    },
  };
}
// 注：`node:fs/promises` 会被 vite 按 `node:fs` alias 前缀替换成 shim 路径而报错，
// 故 createNodeJsonlFs 仅在 headless 使用；GUI 侧使用 createTauriJsonlFs（plugin-fs）。
// 为避免 vite 构建解析 `node:fs/promises`，此文件不得被 GUI 模块静态 import ——
// 实际由 session.ts 在 env==='tauri' 时改为走 tauri-run（见 session.initDevSession）。

/**
 * JSONL 证据存储（每行一条证据，追加写）。
 * 文件路径必须经 createHostEvidenceStore / createHostEvidenceStoreWithFs 由宿主生成——
 * 调用方无法绕过 baseDir/worktree 约束传入任意 filePath（审计修复）。
 */
function createJsonlEvidenceStore(filePath: string, fsOps: JsonlFsOps): EvidencePersistence {
  const dirname = filePath.includes('/') || filePath.includes('\\')
    ? filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
    : '.';
  let appendChain = Promise.resolve();
  return {
    async append(rec) {
      const operation = appendChain.then(async () => {
        decodeEvidenceRecord(rec);
        await fsOps.mkdir(dirname);
        await fsOps.append(filePath, `${JSON.stringify(rec)}\n`);
      });
      appendChain = operation.catch(() => {});
      await operation;
    },
    async load() {
      let text = '';
      try {
        text = await fsOps.read(filePath);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => decodeEvidenceRecord(JSON.parse(l)));
    },
  };
}

export function isMissingFileError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return true;
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return /^(?:dev_read_file:\s*)?(?:ENOENT|file not found|no such file(?: or directory)?|文件不存在|路径不存在)$/i.test(message);
}

/**
 * EvidenceCollector：宿主侧证据采集器。
 * 所有 add 调用强制 capturedBy='host'；调用方（DevCapabilityService）负责在
 * 真实命令/测试/git/路径检查完成后采集——绝不接受模型/节点自报结果。
 * 可选注入 EvidencePersistence（宿主独占路径）。持久化失败默认不阻断内存采集，
 * 但提供 addAsync/flush 供验收流程「等待并确认落盘成功」——未落盘的证据不得作为验收依据。
 */
export class EvidenceCollector {
  private _records: EvidenceRecord[] = [];
  private _pending: Promise<void>[] = [];
  private _persistErrors: string[] = [];

  constructor(private readonly persistence?: EvidencePersistence) {}

  private makeRec(input: EvidenceInput): EvidenceRecord {
    if (input.taskExecutionId !== undefined || input.attemptId !== undefined) {
      assertTaskExecutionLineage({
        runId: input.runId ?? '',
        taskId: input.taskId ?? '',
        taskExecutionId: input.taskExecutionId,
        attemptId: input.attemptId,
      });
    }
    return {
      ...input,
      id: nextId(),
      capturedBy: 'host',
      createdAt: new Date().toISOString(),
    };
  }

  /** fire-and-forget 落盘（不等待；持久化失败记录到 persistErrors）。 */
  add(input: EvidenceInput): EvidenceRecord {
    const rec = this.makeRec(input);
    this._records.push(rec);
    if (this.persistence) {
      const p = Promise.resolve()
        .then(() => this.persistence!.append(rec))
        .catch((e: unknown) => {
        this._records = this._records.filter((item) => item !== rec);
        this._persistErrors.push(
          `证据 ${rec.id} 落盘失败：${e instanceof Error ? e.message : String(e)}`,
        );
      });
      this._pending.push(p);
    }
    return rec;
  }

  /** 添加并等待该条落盘成功（失败 throw——验收关键证据必须确认持久化）。 */
  async addAsync(input: EvidenceInput): Promise<EvidenceRecord> {
    const rec = this.makeRec(input);
    this._records.push(rec);
    const persistence = this.persistence;
    if (persistence) {
      const verification = (async () => {
        await persistence.append(rec);
        const persisted = await persistence.load();
        const matches = persisted.filter((item) => item.id === rec.id);
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(rec)) {
          throw new Error(`Evidence 持久化 read-back 不一致：${rec.id}`);
        }
      })();
      const tracked = verification.catch((error: unknown) => {
        this._records = this._records.filter((item) => item !== rec);
        this._persistErrors.push(
          `证据 ${rec.id} 落盘失败：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
      this._pending.push(tracked.catch(() => {}));
      await tracked;
    }
    return rec;
  }

  /** 等待所有在途落盘完成；若有失败则 throw 汇总错误（验收前必须 flush）。 */
  async flush(): Promise<void> {
    const pending = this._pending;
    this._pending = [];
    await Promise.all(pending);
    if (this._persistErrors.length > 0) {
      const errs = this._persistErrors;
      this._persistErrors = [];
      throw new Error(`证据持久化存在失败，不能作为验收依据：${errs.join('；')}`);
    }
  }

  /** 启动/恢复：从持久化 store 载入历史证据（强制 capturedBy='host'）。 */
  async loadPersisted(): Promise<EvidenceRecord[]> {
    if (!this.persistence) return [];
    const recs = (await this.persistence.load()).map((record) => decodeEvidenceRecord(record));
    const loadedById = new Map<string, EvidenceRecord>();
    for (const record of recs) {
      const existing = loadedById.get(record.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Evidence ID 内容冲突：${record.id}`);
      }
      loadedById.set(record.id, record);
    }
    const currentById = new Map(this._records.map((record) => [record.id, record]));
    for (const record of loadedById.values()) {
      const existing = currentById.get(record.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Evidence ID 内容冲突：${record.id}`);
      }
    }
    for (const record of loadedById.values()) {
      if (!currentById.has(record.id)) this._records.push(record);
    }
    return [...loadedById.values()];
  }

  get records(): readonly EvidenceRecord[] {
    return this._records;
  }

  get persistErrors(): readonly string[] {
    return this._persistErrors;
  }

  /** 是否配置了宿主持久化（EvidenceStore）。高风险操作（如 forceCleanup）的审计前提。 */
  hasPersistence(): boolean {
    return this.persistence !== undefined;
  }

  /**
   * 一次性注入宿主持久化（GUI 动态 worktree 场景：worktree 创建后才确定证据根，惰性绑定）。
   * 已有 persistence 时拒绝覆盖（防运行期被替换——审计前提不可变）。
   */
  attachPersistence(p: EvidencePersistence): void {
    if (this.persistence) {
      throw new Error('EvidenceCollector 已配置宿主持久化，禁止运行期替换');
    }
    (this as unknown as { persistence?: EvidencePersistence }).persistence = p;
  }

  /** 追加已构造好的证据（批量恢复用；仍强制 capturedBy='host'）。 */
  restore(rec: EvidenceRecord): void {
    this._records.push(decodeEvidenceRecord(rec));
  }

  /** 按阶段过滤。 */
  byStage(stageId: string): EvidenceRecord[] {
    return this._records.filter((r) => r.stageId === stageId);
  }

  /**
   * 证据作用域过滤（P1 审计：严格匹配）。
   * 验收/引用时若 scope 指定了某项，证据**必须存在该字段且严格匹配**——缺字段的历史证据
   * 直接排除（不得「没写就不校验」混入）。worktreePath 经 resolve 规范化比较。
   */
  byScope(scope: {
    orchestrationId?: string;
    stageId?: string;
    taskExecutionId?: string;
    attemptId?: string;
    worktreePath?: string;
  }): EvidenceRecord[] {
    return this._records.filter((r) => {
      if (scope.orchestrationId !== undefined) {
        if (r.orchestrationId !== scope.orchestrationId) return false;
      }
      if (scope.stageId !== undefined) {
        if (r.stageId !== scope.stageId) return false;
      }
      if (scope.taskExecutionId !== undefined && r.taskExecutionId !== scope.taskExecutionId) {
        return false;
      }
      if (scope.attemptId !== undefined && r.attemptId !== scope.attemptId) {
        return false;
      }
      if (scope.worktreePath !== undefined) {
        if (!r.worktreePath) return false; // 缺 worktreePath 的证据排除
        if (pathComparisonKey(r.worktreePath) !== pathComparisonKey(scope.worktreePath)) {
          return false;
        }
      }
      return true;
    });
  }

  /** 验收前强制 flush + 按作用域取证据（落盘失败 throw，未落盘的证据不作为验收依据）。 */
  async flushAndByScope(
    scope: {
      orchestrationId?: string;
      stageId?: string;
      taskExecutionId?: string;
      attemptId?: string;
      worktreePath?: string;
    },
  ): Promise<EvidenceRecord[]> {
    await this.flush();
    return this.byScope(scope);
  }

  clear(): void {
    this._records = [];
    this._pending = [];
    this._persistErrors = [];
  }

  toJSON(): EvidenceRecord[] {
    return [...this._records];
  }
}
