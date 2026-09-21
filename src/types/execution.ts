import type { CostRecord } from './agent';
import type { NodeStatus } from './graph';

/* ---------- 运行历史 ---------- */
export interface RunNodeResult {
  id: string;
  label: string;
  typeId: string;
  status: NodeStatus;
  outputs: Record<string, unknown> | null;
  error: string | null;
  /** 节点开始执行的时间戳（ISO），缓存/跳过节点为 null（未真正执行） */
  startedAt: string | null;
  /** 节点实际执行耗时（毫秒）；缓存命中/跳过/上游失败为 null */
  durationMs: number | null;
  /** 该节点产生的成本记录（仅 LLM 节点有；非 LLM 或缓存命中为 null） */
  cost?: CostRecord[] | null;
}

export interface RunRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'success' | 'error' | 'aborted';
  nodeCount: number;
  nodes: RunNodeResult[];
  /** 成本聚合：全链路 token 用量与耗时（成本可观测性 / 自优化闭环） */
  cost?: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalDurationMs: number;
    /** 缓存统计（命中/未命中/写入的 tokens；按 prompt tokens 口径） */
    cache: {
      hitTokens: number;
      missTokens: number;
      writeTokens: number;
    };
    /** 输出细分：推理过程 vs 回复内容 */
    output: {
      reasoningTokens: number;
      replyTokens: number;
    };
    /** 按模型归类的用量，便于「性价比」分析 */
    byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }>;
    records: CostRecord[];
  } | null;
  /** 摘要说明与成败标记（StatusBar 运行历史行使用） */
  note?: string;
  ok?: boolean;
}

/* ---------- 日志 ---------- */
export interface LogEntry {
  time: string;
  level: 'info' | 'error' | 'warn';
  message: string;
  /** 可选：单次运行的摘要说明与成败标记（运行历史行使用） */
  note?: string;
  ok?: boolean;
}
