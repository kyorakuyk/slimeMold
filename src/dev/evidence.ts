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
 * append 在 add 时 fire-and-forget 调用；load 用于启动/恢复跨会话审计。
 */
export interface EvidencePersistence {
  append(rec: EvidenceRecord): Promise<void>;
  load(): Promise<EvidenceRecord[]>;
}

/**
 * JSONL 证据存储（每行一条证据，追加写）。仅 Node 环境可用（动态 import fs）——
 * 浏览器/WebView 调用即 reject，由宿主在 headless/CI 或 Tauri Rust 通道侧使用。
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
 * 可选注入 EvidencePersistence（宿主独占路径），add 时同步落盘。
 */
export class EvidenceCollector {
  private _records: EvidenceRecord[] = [];

  constructor(private readonly persistence?: EvidencePersistence) {}

  add(input: EvidenceInput): EvidenceRecord {
    const rec: EvidenceRecord = {
      ...input,
      id: nextId(),
      capturedBy: 'host',
      createdAt: new Date().toISOString(),
    };
    this._records.push(rec);
    if (this.persistence) {
      void this.persistence.append(rec).catch(() => {
        // 落盘失败不阻断采集（内存仍保留）；由宿主告警审计缺失
      });
    }
    return rec;
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
  }

  toJSON(): EvidenceRecord[] {
    return [...this._records];
  }
}
