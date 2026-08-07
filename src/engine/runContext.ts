/**
 * runContext.ts — 运行上下文（RunContext）与执行策略的定型。
 *
 * 背景：Codex 第二阶段规划的核心是「建立运行任务模型，而不是继续机械拆文件」。
 * 现有执行引擎靠 `runGens` 哈希表 + `ExecutionRuntime` 接口散落状态，缺少一个
 * 贯穿「一次运行」的实体对象。RunContext 把一次运行的关键维度收拢到一个结构体，
 * 作为后续统一事件流（runEvents.ts）、检查点持久化、AgentRouter 决策的共同载体。
 *
 * 设计原则：
 * - RunContext 是「只读输入 + 运行期资源句柄」的集合，不含调度逻辑（调度仍在 executor）。
 * - 字段对齐既有 `runGens` / `RunOptions` / `RunResources`，不重复造轮子，只做聚合与归一。
 * - 纯类型 + 工厂函数，零 store 依赖，便于在 headless / 测试中使用。
 */
import type { RunResources } from './runResources';
import type { RunOptions } from './executor';

/** 一次运行的执行策略（由 RunOptions 归一而来，仅保留运行期关心的维度）。 */
export interface ExecutionPolicy {
  /** 增量模式：只执行脏节点及其下游 */
  incremental: boolean;
  /** 失败续跑：仅重跑 error 节点及其下游 */
  retryFailed: boolean;
  /** 失败时继续（skipFailed）：某节点失败后不中断整体、下游以空输入继续 */
  skipFailed: boolean;
  /** 强制重算：清空节点缓存，不复用上一轮结果 */
  forceRerun: boolean;
  /** 单节点孤立运行：只有 forceNodes 参与、不汇聚上游 */
  isolated: boolean;
  /** 执行到这些节点为止（含），下游标记 skipped */
  stopAfterNodes: string[];
  /** 强制重算的节点集合 */
  forceNodes: string[];
  /** 沙箱隔离：为 true 时每个写文件节点获得独立隔离目录 */
  sandbox: boolean;
  /** 沙箱隔离强度 */
  sandboxMode: 'copy' | 'gitworktree';
  /** 并发上限（0 表示使用全局默认） */
  maxConcurrency: number;
  /** 调度轮次上限（循环门），0 表示取节点 maxLoops */
  maxLoopsOverride: number;
}

/** 一次运行的完整上下文：贯穿 run.created → run.completed 的所有维度。 */
export interface RunContext {
  /** 项目 id（来自 projectId，跨工作流隔离与持久化用） */
  projectId: string | null;
  /** 工作流 id（拆分视图左右栏独立运行） */
  wfId: string;
  /** 运行代次号（runGens 中自增取得，标识一次具体运行实例） */
  runId: number;
  /** 本次运行的目标描述（供 Job Board / 事件展示；缺省取工作流名） */
  goal: string;
  /** 中止信号（与 runGens 中 AbortController 同源） */
  signal: AbortSignal;
  /** 启动时刻（performance.now() 基准，用于耗时统计） */
  startedAt: number;
  /** 真实墙钟启动时刻（Date.now()，用于历史记录） */
  startedWall: number;
  /** 本次运行的资源句柄（沙箱 / git worktree，由 runResources 管理） */
  resources: RunResources;
  /** 归一后的执行策略 */
  policy: ExecutionPolicy;
}

/** 由 RunOptions + 运行期已知量构建一个 ExecutionPolicy（纯函数，可单测）。 */
export function derivePolicy(opts: RunOptions, defaults: { maxConcurrency: number }): ExecutionPolicy {
  return {
    incremental: opts.incremental ?? false,
    retryFailed: opts.retryFailed ?? false,
    skipFailed: opts.skipFailed ?? false,
    forceRerun: opts.forceRerun ?? false,
    isolated: opts.isolated ?? false,
    stopAfterNodes: opts.stopAfterNodes ?? [],
    forceNodes: opts.forceNodes ?? [],
    sandbox: opts.sandbox ?? false,
    sandboxMode: opts.sandboxMode ?? 'copy',
    maxConcurrency: opts.maxConcurrency ?? defaults.maxConcurrency,
    maxLoopsOverride: opts.maxLoopsOverride ?? 0,
  };
}
