/**
 * H4 证据模型（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §4）。
 *
 * StageLog 回答「阶段运行到什么状态」，EvidenceLog 回答「系统有什么客观证据证明阶段完成」——
 * 两者职责分离。关键约束：capturedBy 恒为 'host'，Agent（模型/工作流节点）不能自报事实证据，
 * 只能写 uncertainties/agentSummary 辅助文本。
 */
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
  worktreePath?: string;
  baseRevision?: string;
  headRevision?: string;
  contentHash?: string;
  createdAt: string;
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
  seq += 1;
  return `ev-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * Evidence 持久化接口：宿主独占落盘（EvidenceStore 必须位于 worktree 之外）。
 * append 在 add 时调用；load 用于启动/恢复跨会话审计。
 */
export interface EvidencePersistence {
  append(rec: EvidenceRecord): Promise<void>;
  load(): Promise<EvidenceRecord[]>;
}

/** 规范化路径（POSIX 分隔符、去尾部 /；不解析 ..——相交判定用）。 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 宿主统一约束的 EvidenceStore 路径（审计修复）：
 * - baseDir 由宿主指定（如 `<项目根>/.slimemold/evidence/`，位于 worktree 之外）；
 * - key 只允许 `[a-zA-Z0-9._-]`，**拒绝任何路径分隔符与 `..`**（防 `../` 逃逸到任意目录）；
 * - 返回 `<baseDir>/<key>.jsonl` 绝对路径。
 */
export function evidencePathFor(baseDir: string, key: string): string {
  if (!/^[\w.-]+$/.test(key) || key.includes('..')) {
    throw new Error(`非法证据存储 key：${key}（仅允许 [a-zA-Z0-9._-]，禁止路径分隔符/..）`);
  }
  return `${normPath(baseDir)}/${key}.jsonl`;
}

/**
 * 校验 baseDir 与 worktree 路径不相交（P1 审计修复）：
 * 任一方是另一方的祖先或等价 → 拒绝（EvidenceStore 必须位于 worktree 之外）。
 */
export function assertEvidenceOutsideWorktree(baseDir: string, worktreePath: string): void {
  const b = normPath(baseDir);
  const w = normPath(worktreePath);
  if (b === w || w.startsWith(b + '/') || b.startsWith(w + '/')) {
    throw new Error(`EvidenceStore 必须位于 worktree 之外：baseDir=${b}，worktree=${w}`);
  }
}

/**
 * 宿主构造 EvidenceStore（P1 审计修复）：
 * - 不接受 Agent 提供的任意 baseDir——由宿主传入证据根（如 `.slimemold/evidence`）与 worktreePath；
 * - 校验二者不相交（assertEvidenceOutsideWorktree）+ key 合法（evidencePathFor）；
 * - 返回 JSONL 持久化实例。
 */
export function createHostEvidenceStore(
  evidenceRoot: string,
  worktreePath: string,
  key: string,
): EvidencePersistence {
  assertEvidenceOutsideWorktree(evidenceRoot, worktreePath);
  return createJsonlEvidenceStore(evidencePathFor(evidenceRoot, key));
}

/**
 * JSONL 证据存储（每行一条证据，追加写）。仅 Node 环境可用（动态 import fs）——
 * 浏览器/WebView 调用即 reject，由宿主在 headless/CI 或 Tauri Rust 通道侧使用。
 * 文件路径必须经 evidencePathFor/createHostEvidenceStore 由宿主生成（不接受调用方任意 filePath）。
 */
export function createJsonlEvidenceStore(filePath: string): EvidencePersistence {
  return {
    async append(rec) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(filePath, `${JSON.stringify(rec)}\n`, 'utf8');
    },
    async load() {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(filePath, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as EvidenceRecord);
    },
  };
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
      const p = this.persistence.append(rec).catch((e: unknown) => {
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
    if (this.persistence) {
      const p = this.persistence.append(rec);
      this._pending.push(p.catch(() => {}));
      await p;
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
    const recs = await this.persistence.load();
    for (const r of recs) this.restore(r);
    return recs;
  }

  get records(): readonly EvidenceRecord[] {
    return this._records;
  }

  get persistErrors(): readonly string[] {
    return this._persistErrors;
  }

  /** 追加已构造好的证据（批量恢复用；仍强制 capturedBy='host'）。 */
  restore(rec: EvidenceRecord): void {
    this._records.push({ ...rec, capturedBy: 'host' });
  }

  /** 按阶段过滤。 */
  byStage(stageId: string): EvidenceRecord[] {
    return this._records.filter((r) => r.stageId === stageId);
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
