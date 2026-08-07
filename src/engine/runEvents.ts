/**
 * runEvents.ts — 统一运行事件总线（Codex 第二阶段基础设施）。
 *
 * 背景：现有 JobBoard / 状态栏靠「直接读 Zustand 零散字段」拼出运行状态，Codex 明确指出
 * 「不要让 UI 直接猜测 store 中零散字段」。本模块提供一条贯穿运行级与节点级的统一事件流，
 * 所有日志、成本、进度、Artifact 都携带 `wfId + runId + nodeId`，作为 Job Board、实时接管、
 * 运行回放、暂停/恢复的共同数据源。
 *
 * 设计原则：
 * - 纯事件分发器，零 store 依赖；订阅者（UI / 历史回放 / 测试）自行决定是否消费。
 * - 事件结构稳定（`RunEvent` 联合类型），新增事件类型不影响已有订阅者（结构兼容）。
 * - 支持「重放」：订阅者可在订阅时拿到当前缓冲区内的历史事件（可选），便于 UI 挂载即同步。
 */

/** 运行级事件类型（一次运行从创建到终结的生命周期）。 */
export type RunEventKind =
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.aborted'
  | 'run.completed'
  | 'run.failed'
  | 'node.started'
  | 'node.progress'
  | 'node.completed'
  | 'node.failed'
  | 'node.skipped';

/** 统一事件负载：所有字段携带运行三元组定位（wfId + runId + nodeId）。 */
export interface RunEvent {
  /** 事件种类 */
  kind: RunEventKind;
  /** 工作流 id */
  wfId: string;
  /** 运行代次号（标识一次具体运行实例） */
  runId: number;
  /** 节点 id（运行级事件为 null） */
  nodeId: string | null;
  /** 事件发生的墙钟时刻（Date.now()） */
  at: number;
  /** 自由负载：进度、状态、成本、错误消息等，按 kind 不同而不同 */
  payload?: Record<string, unknown>;
}

/** 事件订阅回调。 */
export type RunEventSink = (e: RunEvent) => void;

/** 事件总线实例（由 createEventBus 创建，避免模块级单例在测试中互相污染）。 */
export interface EventBus {
  /** 订阅事件流，返回取消订阅函数 */
  subscribe(sink: RunEventSink): () => void;
  /** 派发一个事件（自动填充 at 墙钟时刻） */
  emit(e: Omit<RunEvent, 'at'>): void;
  /** 取当前历史事件缓冲（用于 UI 挂载即同步 / 测试回放） */
  history(wfId?: string, runId?: number): RunEvent[];
  /** 清空缓冲区（测试隔离用） */
  clear(): void;
}

/**
 * 创建事件总线。
 * @param opts.bufferSize 历史事件缓冲上限（默认 1000，超出 FIFO 丢弃最旧）
 */
export function createEventBus(opts: { bufferSize?: number } = {}): EventBus {
  const bufferSize = opts.bufferSize ?? 1000;
  const sinks = new Set<RunEventSink>();
  const buf: RunEvent[] = [];

  const push = (e: RunEvent) => {
    buf.push(e);
    if (buf.length > bufferSize) buf.splice(0, buf.length - bufferSize);
    for (const s of sinks) s(e);
  };

  return {
    subscribe(sink: RunEventSink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(e: Omit<RunEvent, 'at'>) {
      push({ ...e, at: Date.now() });
    },
    history(wfId?: string, runId?: number) {
      return buf.filter((e) => (wfId == null || e.wfId === wfId) && (runId == null || e.runId === runId));
    },
    clear() {
      buf.length = 0;
      sinks.clear();
    },
  };
}

/**
 * 运行级事件便捷构造器（减少调用方样板）。
 * 用法：emitRun(bus, 'run.completed', ctx, { status: 'success' })
 */
export function emitRun(
  bus: EventBus,
  kind: 'run.created' | 'run.started' | 'run.paused' | 'run.aborted' | 'run.completed' | 'run.failed',
  ctx: { wfId: string; runId: number },
  payload?: Record<string, unknown>,
): void {
  bus.emit({ kind, wfId: ctx.wfId, runId: ctx.runId, nodeId: null, payload });
}

/** 节点级事件便捷构造器。 */
export function emitNode(
  bus: EventBus,
  kind: 'node.started' | 'node.progress' | 'node.completed' | 'node.failed' | 'node.skipped',
  ctx: { wfId: string; runId: number },
  nodeId: string,
  payload?: Record<string, unknown>,
): void {
  bus.emit({ kind, wfId: ctx.wfId, runId: ctx.runId, nodeId, payload });
}

/**
 * 全局单例：executor 生产、UI（JobBoard / 状态栏 / 历史回放）消费同一事件流。
 * 惰性创建；resetRunBus() 供测试隔离（避免 Vitest 用例间事件互相污染）。
 */
let globalRunBus: EventBus | null = null;

export function getRunBus(): EventBus {
  globalRunBus ??= createEventBus({ bufferSize: 1000 });
  return globalRunBus;
}

export function resetRunBus(): void {
  globalRunBus = null;
}
