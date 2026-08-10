/**
 * eventLog.ts — 可选脱敏运行摘要事件日志（Codex 设计评审 G4，P2）。
 *
 * 背景：统一事件总线（runEvents）是内存态，运行回放/审计依赖 checkpoint + runHistory 落盘。
 * 但完整事件流（含 node.progress 中间态）不落盘，长任务中途退出后无法回放过程。Codex 指出
 * 「不推荐全量落盘（体积/敏感数据/写放大/schema 兼容），建议可选 eventPersistence: off|summary|full，
 * 默认 off/summary，写 .slimemold/runs/{wfId}/{runId}/events.jsonl」。
 *
 * 设计：
 * - 三档：off（不写）/ summary（脱敏摘要：剥离 outputs/error 详情/进度，仅结构化字段）/
 *   full（含 outputs，但剥离 apiKey 等敏感键）。
 * - 缓冲式：订阅事件流，满 N 条或运行结束时一次性 append 到 jsonl（避免每事件写盘放大）。
 * - 纯函数 + 模块级单例（模式开关），零 store 依赖；sink 由调用方（executor）挂接。
 */
import type { RunEvent } from './runEvents';
import { isTauri } from '../platform/env';

/** 事件持久化模式。 */
export type EventPersistenceMode = 'off' | 'summary' | 'full';

/** 事件日志文件路径（相对项目根）：.slimemold/runs/{wfId}/{runId}/events.jsonl */
export function eventLogRelPath(wfId: string, runId: number): string {
  return `.slimemold/runs/${encodeURIComponent(wfId)}/${runId}/events.jsonl`;
}

/** 每事件一条 JSON line；缓冲达到该阈值时 flush 一次。 */
const FLUSH_THRESHOLD = 32;

/** 敏感键正则：命中即从 payload 剥离（apiKey / secret / token / password / authorization）。 */
const SENSITIVE_KEY_RE = /(api[_ -]?key|secret|token|passwd|password|authorization)/i;

/** 摘要模式保留的 payload 键白名单（结构化、无敏感内容）。 */
const SUMMARY_PAYLOAD_KEYS = new Set([
  'status',
  'reason',
  'failed',
  'skipped',
  'pruned',
  'durationMs',
  'elapsed',
  'mode',
  'count',
  'layer',
  'totalLayers',
  'round',
  'totalRounds',
  'typeId',
  'label',
  'agentId',
  'requestedAgentId',
  'category',
  'tier',
  'progressKind',
]);

/**
 * 把事件脱敏为可落盘的一条记录（纯函数）。
 * - summary：payload 仅保留白名单键，剥离 outputs/error/消息正文等可能含敏感内容或过大的字段；
 * - full：保留完整 payload，但剥离命中敏感键的字段（含嵌套对象中递归剥离第一层）。
 */
export function sanitizeEvent(e: RunEvent, mode: Exclude<EventPersistenceMode, 'off'>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: e.kind,
    at: e.at,
    wfId: e.wfId,
    runId: e.runId,
    nodeId: e.nodeId,
  };
  const p = e.payload ?? {};
  if (mode === 'summary') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (SUMMARY_PAYLOAD_KEYS.has(k)) out[k] = v;
    }
    return { ...base, payload: out };
  }
  // full：递归剥离敏感键（第一层对象）
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY_RE.test(k)) continue;
        o[k] = strip(val);
      }
      return o;
    }
    return v;
  };
  return { ...base, payload: strip(p) };
}

/**
 * 事件日志写入器（每运行实例一个）。
 * 缓冲事件 → 满阈值 flush；flush() 幂等；close() 强刷并释放。
 */
export class EventLogWriter {
  private buf: string[] = [];
  private closed = false;
  private flushes = 0;

  constructor(
    private readonly root: string,
    private readonly wfId: string,
    private readonly runId: number,
    private readonly mode: Exclude<EventPersistenceMode, 'off'>,
  ) {}

  /** 追加一条事件（脱敏后入缓冲；满阈值触发 flush）。 */
  append(e: RunEvent): void {
    if (this.closed) return;
    this.buf.push(JSON.stringify(sanitizeEvent(e, this.mode)));
    if (this.buf.length >= FLUSH_THRESHOLD) void this.flush();
  }

  /** 把缓冲写入 .slimemold/runs/{wfId}/{runId}/events.jsonl（覆盖式：该运行首次写全量，后续追加）。 */
  async flush(): Promise<void> {
    if (this.closed || this.buf.length === 0) return;
    const lines = this.buf.splice(0, this.buf.length).join('\n') + '\n';
    this.flushes += 1;
    try {
      if (!isTauri) return;
      const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
      const dir = `${this.root.replace(/[\\/]+$/, '')}/${eventLogRelPath(this.wfId, this.runId)}`;
      const dirPath = dir.slice(0, dir.lastIndexOf('/'));
      await mkdir(dirPath, { recursive: true });
      // 首次写创建，后续追加：读已有 + 拼新行（jsonl 简单追加；数据量受阈值限制，可接受）
      if (this.flushes === 1) {
        await writeTextFile(dir, lines);
      } else {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const prev = await readTextFile(dir).catch(() => '');
        await writeTextFile(dir, prev + lines);
      }
    } catch {
      /* 日志失败不阻断运行 */
    }
  }

  /** 强刷并关闭（运行收尾调用）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }
}

/* ---------------- 模块级开关与活跃写入器 ---------------- */

let currentMode: EventPersistenceMode = 'off';
/** 活跃写入器：key = `${wfId}:${runId}`（拆分视图多工作流可并存）。 */
const activeWriters = new Map<string, EventLogWriter>();

/** 设置全局事件持久化模式（off 时清空活跃写入器）。 */
export function setEventPersistenceMode(m: EventPersistenceMode): void {
  currentMode = m;
  if (m === 'off') {
    for (const w of activeWriters.values()) void w.close();
    activeWriters.clear();
  }
}

export function getEventPersistenceMode(): EventPersistenceMode {
  return currentMode;
}

/**
 * 创建（或复用）某运行的日志写入器并挂接到事件总线，返回取消函数。
 * mode 为 off 时直接返回 no-op（零开销）。
 */
export function attachEventLog(
  bus: { subscribe(sink: (e: RunEvent) => void): () => void },
  root: string,
  wfId: string,
  runId: number,
  mode?: EventPersistenceMode,
): () => void {
  const m = mode ?? currentMode;
  if (m === 'off') return () => {};
  const key = `${wfId}:${runId}`;
  let writer = activeWriters.get(key);
  if (!writer) {
    writer = new EventLogWriter(root, wfId, runId, m);
    activeWriters.set(key, writer);
  }
  const off = bus.subscribe((e) => {
    if (e.wfId !== wfId || e.runId !== runId) return;
    writer!.append(e);
  });
  // 返回取消：退订 + 收尾 close（从活跃表移除）
  return () => {
    off();
    activeWriters.delete(key);
    void writer!.close();
  };
}

/** 测试隔离：清空活跃写入器并重置模式为 off。 */
export function resetEventLog(): void {
  for (const w of activeWriters.values()) void w.close();
  activeWriters.clear();
  currentMode = 'off';
}
