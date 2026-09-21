/**
 * Public run contracts shared by the executor, run context, and orchestration callers.
 * Pure types only; execution behavior remains in executor.ts.
 */

/** 运行工作流的选项（RunOptions）。 */
export interface RunOptions {
  /** 目标工作流 id（拆分视图可独立运行；缺省取当前激活工作流） */
  wfId?: string;
  /** 增量模式：只执行脏节点及其下游（非脏节点复用已有/缓存结果） */
  incremental?: boolean;
  /** 强制重算的节点集合（重跑单节点时使用），会清除其缓存 */
  forceNodes?: string[];
  /** 执行到这些节点为止（含），其下游不再执行（标记 skipped）。用于「重跑到此节点」 */
  stopAfterNodes?: string[];
  /** 单节点运行：仅 forceNodes 内的节点参与执行，且不汇聚任何上游输入。 */
  isolated?: boolean;
  /** 强制重启（忽略并发拦截，用于 Play 按钮检测到运行态卡死时的透传） */
  force?: boolean;
  /** 失败续跑：仅重跑上一轮处于 error 状态的节点及其下游。 */
  retryFailed?: boolean;
  /** 强制轮次上限（调试用），默认取 loopGate 节点的 maxLoops 参数 */
  maxLoopsOverride?: number;
  /** 失败时继续：某节点失败后不中断整体、下游以空上游输出继续尝试。 */
  skipFailed?: boolean;
  /** 强制重跑：清空节点结果缓存，使所有节点重新执行。 */
  forceRerun?: boolean;
  /** 调度进度回调。 */
  onProgress?: (p: { layer: number; totalLayers: number; round: number; totalRounds: number }) => void;
  /** 真沙箱隔离。 */
  sandbox?: boolean;
  /** 本次运行的并发上限（覆盖全局 maxConcurrency）。 */
  maxConcurrency?: number;
  /** 沙箱隔离强度。 */
  sandboxMode?: 'copy' | 'gitworktree';
}

/** runWorkflow 运行结果（status 判定执行成败，runId 精确对应本次运行）。 */
export interface RunResult {
  /** success=无失败节点；error=有失败节点；aborted=手动停止/被顶替/空图/非法图 */
  status: 'success' | 'error' | 'aborted';
  /** 本次运行代次。 */
  runId: number;
  /** 失败/拦截原因（aborted/error 时有） */
  error?: string;
}
