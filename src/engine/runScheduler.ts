/**
 * runScheduler.ts — 单层调度器（executor 拆分第二刀，Codex 推荐「收尾 → 调度 → 循环」）。
 *
 * 把 runWorkflow 主循环里的「单 stage 执行」抽为独立函数 runStage：
 * - 层进度事件（run.progress / onProgress / setRunProgress）
 * - 层内 scope 串行化簇并发（簇间并行、簇内串行）
 * - 逐节点 executeNode 调用（由调用方注入闭包，避免 runScheduler ↔ executor 循环依赖）
 * - fail-fast（有失败即 abort）
 * - 层结束中间检查点快照（由调用方注入 scheduleCheckpoint）
 *
 * 设计原则：纯编排，不直接持有 runWorkflow 闭包；副作用经回调与共享可变容器（failed 等）。
 */
import type { RunContext } from './runContext';
import type { ExecutionRuntime } from './runtime';
import { emitRun, getRunBus } from './runEvents';

/** runStage 输入：层信息、进度/检查点回调、executeNode 注入闭包。 */
export interface RunStageInput {
  /** 该层节点 id 列表 */
  layer: string[];
  /** 层索引（0-based） */
  layerIndex: number;
  /** 总层数 */
  totalLayers: number;
  /** 当前轮次（1-based 展示） */
  round: number;
  /** 总轮数 */
  totalRounds: number;
  /** 该层预计算的串行化簇划分（簇间并行、簇内串行） */
  clusters: string[][];
  failed: Set<string>;
  signal: AbortSignal;
  /** 是否当前代次（代次守卫，供簇内断点） */
  isCurrent: () => boolean;
  /** 是否 fail-fast */
  failFast: boolean;
  /** abort（fail-fast 触发时调用） */
  abort: () => void;
  wfId: string;
  runCtx: RunContext;
  rt: ExecutionRuntime;
  /** 层结束的中间检查点快照（节流） */
  scheduleCheckpoint: () => void;
  /** 进度回调（opts.onProgress） */
  onProgress?: (p: { layer: number; totalLayers: number; round: number; totalRounds: number }) => void;
  /** 执行单个节点（executor 侧闭包绑定 executeNode 全部参数） */
  executeNode: (id: string) => Promise<void>;
}

/** 执行单层：进度事件 → 簇并发 → fail-fast → 层快照。 */
export async function runStage(input: RunStageInput): Promise<void> {
  const {
    layerIndex,
    totalLayers,
    round,
    totalRounds,
    clusters,
    failed,
    signal,
    isCurrent,
    failFast,
    abort,
    wfId,
    runCtx,
    rt,
    scheduleCheckpoint,
    onProgress,
    executeNode,
  } = input;

  if (signal.aborted || !isCurrent()) return;

  // 上报调度进度
  const progress = {
    layer: layerIndex + 1,
    totalLayers,
    round: round + 1,
    totalRounds,
  };
  onProgress?.(progress);
  rt.setRunProgress({ active: true, ...progress }, wfId);
  // A2/A3：调度进度同样进统一事件流
  emitRun(getRunBus(), 'run.progress', runCtx, progress);

  // 簇间并行；每个簇内按列表顺序串行执行（冲突节点被挤进同一簇）
  await Promise.all(
    clusters.map((cluster) =>
      (async () => {
        for (const id of cluster) {
          if (signal.aborted || !isCurrent()) break;
          await executeNode(id);
        }
      })(),
    ),
  );

  if (failFast && failed.size > 0) {
    abort();
    return;
  }
  // 阶段 G2：每层执行完落盘一次中间快照（节流），崩溃恢复可见「已完成层」的成果
  scheduleCheckpoint();
}
