/**
 * Parallel file conflict and council arbitration contracts.
 * Pure types only; no store, engine, or host dependencies.
 */
/* ---------- 文件补丁与冲突协调（步骤 11 沙箱式并行） ---------- */
/** 单条文件改动补丁（逻辑层模拟沙箱，无需真实文件系统隔离）。
 * - path：受影响文件相对路径
 * - before：读取时的原始内容（null 表示新建文件）
 * - after：任务线写入后的内容
 * - readSnapshot：读取时的快照哈希/行区间（借鉴 OMO Hashline，用于合并前精准识别陈旧编辑）
 *   - hash：before 内容的哈希；若别人已动同一处（after 基于旧版本），合并时标记需仲裁
 *   - lineRange：[start,end] 行区间，缺省视为整文件
 *   - source：scope 来源（对应步骤 11.1 并存/剪枝预留）：'object' | 'edge' | 'both' */
export interface FilePatch {
  path: string;
  before: string | null;
  after: string;
  readSnapshot?: {
    hash?: string;
    lineRange?: [number, number];
    source?: 'object' | 'edge' | 'both';
  };
}

/** 协调者合并产物：无逻辑冲突时把多方改动汇总为「同一文件」的最终补丁集。 */
export interface MergeResult {
  /** 可直接合并（文本区间不重叠）的补丁，按 path 汇总 */
  patches: FilePatch[];
  /** 需要人工/council 仲裁的补丁（同一 path 的 after 互相覆盖、或 readSnapshot 提示陈旧编辑） */
  needsArbitration: Array<{ path: string; candidates: FilePatch[] }>;
  /** scope 来源标注（对应步骤 11.1） */
  sources: Array<'object' | 'edge' | 'both'>;
}

/** Council 仲裁裁决结果（对应 OMO-slim Council 合成 single verdict 范式）。 */
export interface CouncilVerdict {
  /** 最终合成裁决（文本） */
  verdict: string;
  /** 各议员（并行评估子节点）独立回复 */
  councillors: Array<{ name: string; reply: string; failed?: boolean }>;
  /** 共识评级（对应 OMO-slim 的 unanimous/majority/split） */
  consensus: 'unanimous' | 'majority' | 'split';
  /** 是否部分议员失败但成功合成 */
  partialFailure: boolean;
}
