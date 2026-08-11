/**
 * H2 PoC：沙箱插件宿主管理器（主线程侧）。
 *
 * 职责：
 * - 按 pluginId 建立/复用 Web Worker（worker 内跑 runtime.ts 引导脚本）；
 * - `execute`：把插件节点调用封装为 postMessage 请求-响应（带超时）；
 * - 能力代理：worker 内 ctx 的 llm/storage/logger 等请求由宿主侧真实 ExecContext 响应，
 *   并按 capability 等级做白名单拦截（Codex P0 修复：宿主侧结构性强制）；
 * - 生命周期：abort（取消）、terminate（超时/崩溃兜底）、worker 崩溃自动重建。
 *
 * 设计见 docs/H2_PLUGIN_ISOLATION_DESIGN.md §3-4。
 */

import type {
  CapabilityLevel,
  CostRecord,
  ExecContext,
  NodeExecuteFn,
} from '../../types';
import { SANDBOX_RUNTIME_SRC } from './runtime';
import type { CapabilityMethod, HostToWorker, WorkerToHost } from './protocol';
import { allowedMethodsFor, isCapabilityAllowed } from './protocol';

/** 默认单次 execute 超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** 心跳探针间隔（毫秒）：execute 期间周期 ping */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** 连续丢失心跳次数超过此值 → 判定 worker 卡死，terminate + 重建 */
export const HEARTBEAT_MISS_THRESHOLD = 3;

/** 宿主侧能力响应函数：按 CapabilityMethod 分派到真实 ExecContext 的方法 */
export type CapabilityResponder = (
  method: CapabilityMethod,
  args: unknown[],
  nodeId: string,
) => Promise<unknown>;

/** 最小 Worker 接口（与 Web Worker + 测试 fake 对齐） */
export interface WorkerLike {
  postMessage(msg: HostToWorker): void;
  terminate(): void;
  onmessage: ((ev: { data: WorkerToHost }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}

export type WorkerFactory = (url: string) => WorkerLike;

/** 单次沙箱执行参数 */
export interface SandboxExecuteParams {
  /** 本次执行的唯一 id（createSandboxedNodeExecute 生成，作 responder 路由键） */
  executionId: string;
  typeId: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  capability: CapabilityLevel;
  nodeId: string;
  vars: Record<string, unknown>;
  costLog: CostRecord[];
  /** 取消信号（宿主 stopWorkflow 传播） */
  signal?: AbortSignal;
  /** 单次执行超时（毫秒），缺省 DEFAULT_TIMEOUT_MS */
  timeoutMs?: number;
}

interface WorkerSlot {
  worker: WorkerLike;
  pluginId: string;
  loaded: boolean;
  dead: boolean;
  ready: Promise<void>;
  current?: {
    executionId: string;
    capability: CapabilityLevel;
    resolve: (o: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    /** execute 超时定时器（dispose 时清理） */
    timer: ReturnType<typeof setTimeout> | null;
    /** 心跳探针定时器（dispose 时清理） */
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    /** 解除 abort 监听的函数（dispose 时调用，避免 listener 泄漏） */
    detachAbort: (() => void) | null;
  };
  /** 心跳状态（execute 期间启用；worker 卡死/死循环时心跳丢失 → 判死重建） */
  heartbeat?: {
    runId: string;
    /** 最近一次 heartbeat 回复时间戳 */
    lastReply: number;
    /** 连续丢失次数（超 threshold 判死） */
    missed: number;
  };
}

export class SandboxManager {
  private slots = new Map<string, WorkerSlot>();
  /** responder 按 executionId 注册（非 pluginId 单例），避免同插件并发互相覆盖 */
  private responders = new Map<string, CapabilityResponder>();
  private makeWorker: WorkerFactory;
  private defaultTimeoutMs: number;
  private heartbeatIntervalMs: number;
  private heartbeatMissThreshold: number;

  constructor(opts?: {
    workerFactory?: WorkerFactory;
    timeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatMissThreshold?: number;
  }) {
    this.makeWorker = opts?.workerFactory ?? defaultWorkerFactory;
    this.defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissThreshold = opts?.heartbeatMissThreshold ?? HEARTBEAT_MISS_THRESHOLD;
  }

  /** 建立（或复用）某插件的 worker 并加载入口源码 */
  private ensureSlot(pluginId: string, entryCode: string): Promise<WorkerSlot> {
    const existing = this.slots.get(pluginId);
    if (existing && !existing.dead) {
      return existing.ready.then(() => existing);
    }
    const url = createRuntimeUrl();
    const worker = this.makeWorker(url);
    const slot: WorkerSlot = {
      worker,
      pluginId,
      loaded: false,
      dead: false,
      ready: new Promise<void>((resolve, reject) => {
        const onLoad = (ev: { data: WorkerToHost }) => {
          const m = ev.data;
          if (m.kind === 'ready') {
            slot.loaded = true;
            // 就绪后：消息路由到 onWorkerMessage，崩溃路由到 onWorkerError
            worker.onmessage = (e2) => this.onWorkerMessage(slot, e2.data);
            worker.onerror = (e2) => this.onWorkerError(slot, e2);
            resolve();
          } else if (m.kind === 'load-error') {
            slot.dead = true;
            this.slots.delete(pluginId);
            worker.onmessage = null;
            reject(new Error(`插件沙箱加载失败：${m.error}`));
          }
        };
        worker.onmessage = onLoad;
        worker.onerror = () => {
          slot.dead = true;
          this.slots.delete(pluginId);
          worker.onmessage = null;
          reject(new Error('插件沙箱 worker 崩溃（加载阶段）'));
        };
      }),
    };
    this.slots.set(pluginId, slot);
    worker.postMessage({ kind: 'load-plugin', pluginId, entryCode });
    return slot.ready.then(() => slot);
  }

  /**
   * 沙箱执行：确保 worker 就绪 → 发送 execute → 等待结果/错误/超时。
   */
  async execute(
    pluginId: string,
    entryCode: string,
    params: SandboxExecuteParams,
  ): Promise<Record<string, unknown>> {
    let slot = await this.ensureSlot(pluginId, entryCode);
    if (slot.dead) {
      this.slots.delete(pluginId);
      slot = await this.ensureSlot(pluginId, entryCode);
    }
    return this.runOnSlot(slot, params);
  }

  private runOnSlot(slot: WorkerSlot, params: SandboxExecuteParams): Promise<Record<string, unknown>> {
    if (slot.current) {
      return Promise.reject(
        new Error('沙箱插件当前正在执行另一个节点，暂不支持并发（PoC 限制）'),
      );
    }
    const id = params.executionId;
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const runId = `run-${Date.now()}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // 先声明 current 引用（timer/heartbeatTimer/detachAbort 延迟赋值，dispose 时读取）
      // resolve/reject 包装：首次调用即统一清理定时器 + 置空 current/heartbeat，
      // 避免「正常完成但 slot.current 残留」导致同 slot 后续 execute 被并发拦截误伤。
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (current.timer) clearTimeout(current.timer);
        if (current.heartbeatTimer) clearInterval(current.heartbeatTimer);
        current.detachAbort?.();
        slot.current = undefined;
        slot.heartbeat = undefined;
      };
      const current: NonNullable<WorkerSlot['current']> = {
        executionId: id,
        capability: params.capability,
        resolve: (o) => {
          finish();
          resolve(o);
        },
        reject: (e) => {
          finish();
          reject(e);
        },
        timer: null,
        heartbeatTimer: null,
        detachAbort: null,
      };
      slot.current = current;
      slot.heartbeat = { runId, lastReply: Date.now(), missed: 0 };

      // 超时：disposeSlot 统一清理定时器 + terminate + reject
      current.timer = setTimeout(() => {
        this.disposeSlot(
          slot,
          new Error(`插件执行超时（${timeoutMs}ms）：${params.typeId}`),
          true,
        );
      }, timeoutMs);

      // 心跳探针：execute 期间周期 ping，连续丢失超阈值 → 判死重建（死循环/卡死检测）
      current.heartbeatTimer = setInterval(() => {
        const hb = slot.heartbeat;
        if (!hb || hb.runId !== runId) return;
        hb.missed += 1;
        if (hb.missed > this.heartbeatMissThreshold) {
          this.disposeSlot(
            slot,
            new Error(`插件沙箱心跳丢失（worker 疑似死循环/卡死）：${params.typeId}`),
            true,
          );
          return;
        }
        slot.worker.postMessage({ kind: 'ping', runId });
      }, this.heartbeatIntervalMs);

      // 取消：宿主 signal abort → 转发 abort 消息（worker 内 ctx.signal 触发）
      if (params.signal) {
        const onAbort = () => {
          slot.worker.postMessage({ kind: 'abort', runId });
        };
        if (params.signal.aborted) onAbort();
        else {
          params.signal.addEventListener('abort', onAbort, { once: true });
          // 记录解除函数，dispose 时调用避免 listener 泄漏
          current.detachAbort = () => params.signal?.removeEventListener('abort', onAbort);
        }
      }
      slot.worker.postMessage({
        kind: 'execute',
        id,
        typeId: params.typeId,
        inputs: params.inputs,
        params: params.params,
        capability: params.capability,
        nodeId: params.nodeId,
        // 白名单随 execute 下发，worker 只消费此列表（避免双份复制漂移，Codex P2）
        allowedMethods: allowedMethodsFor(params.capability),
        vars: params.vars,
        costLog: params.costLog,
      });
    });
  }

  /** worker → 宿主消息处理 */
  private onWorkerMessage(slot: WorkerSlot, m: WorkerToHost): void {
    switch (m.kind) {
      case 'execute:result':
        slot.current?.resolve(m.outputs);
        break;
      case 'execute:error':
        slot.current?.reject(new Error(m.error));
        break;
      case 'capability:request': {
        // 白名单拦截（Codex P0 修复）：即使 worker 侧漏挂，宿主侧也强制校验等级
        const cur = slot.current;
        if (!cur || cur.executionId !== m.executionId) {
          slot.worker.postMessage({
            kind: 'capability:response',
            id: m.id,
            ok: false,
            error: `能力请求不属于当前执行（executionId 不匹配）`,
          });
          return;
        }
        if (!isCapabilityAllowed(cur.capability, m.method)) {
          slot.worker.postMessage({
            kind: 'capability:response',
            id: m.id,
            ok: false,
            error: `权限不足：${cur.capability} 级不允许调用 ${m.method}`,
          });
          return;
        }
        const responder = this.responders.get(m.executionId);
        if (!responder) {
          slot.worker.postMessage({
            kind: 'capability:response',
            id: m.id,
            ok: false,
            error: `宿主未为本次执行 ${m.executionId} 注册能力处理器`,
          });
          return;
        }
        responder(m.method, m.args, m.nodeId)
          .then((value) =>
            slot.worker.postMessage({ kind: 'capability:response', id: m.id, ok: true, value }),
          )
          .catch((err: unknown) =>
            slot.worker.postMessage({
              kind: 'capability:response',
              id: m.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        break;
      }
      case 'heartbeat': {
        // 心跳回复：重置连续丢失计数（死循环/卡死检测）
        const hb = slot.heartbeat;
        if (hb && hb.runId === m.runId) {
          hb.lastReply = Date.now();
          hb.missed = 0;
        }
        break;
      }
      default:
        // log / cost / partial / ready / load-error：PoC 阶段宿主按需消费
        break;
    }
  }

  /** worker 崩溃：disposeSlot 统一清理 + reject + terminate + 重建 */
  private onWorkerError(slot: WorkerSlot, ev: { message?: string }): void {
    this.disposeSlot(
      slot,
      new Error(`插件沙箱崩溃：${ev.message ?? '未知错误'}`),
      true,
    );
  }

  /**
   * 统一销毁槽位（超时 / 心跳判死 / 崩溃 / terminateAll 共用）：
   * - 清理 execute 超时 timer 与心跳 interval
   * - 解除 abort listener（防泄漏）
   * - reject 在途执行的 Promise
   * - terminate worker；rebuild=true 时移除槽位（下次 execute 自动重建）
   */
  private disposeSlot(slot: WorkerSlot, err: Error, rebuild: boolean): void {
    const cur = slot.current;
    if (cur) {
      if (cur.timer) clearTimeout(cur.timer);
      if (cur.heartbeatTimer) clearInterval(cur.heartbeatTimer);
      cur.detachAbort?.();
      slot.current = undefined;
      slot.heartbeat = undefined;
      cur.reject(err);
    }
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      /* ignore */
    }
    if (rebuild) this.slots.delete(slot.pluginId);
  }

  /** 注册本次执行的能力处理器（按 executionId，非 pluginId——避免并发覆盖） */
  registerResponder(executionId: string, responder: CapabilityResponder): void {
    this.responders.set(executionId, responder);
  }

  unregisterResponder(executionId: string): void {
    this.responders.delete(executionId);
  }

  /**
   * 终止所有沙箱（卸载插件 / 切换项目时调用）。
   * 对在途 execute 统一 reject（「插件沙箱已卸载/终止」）并清理定时器/abort listener，
   * 避免 Promise 悬挂、心跳 interval 残留运行。
   */
  terminateAll(): void {
    for (const slot of this.slots.values()) {
      this.disposeSlot(slot, new Error('插件沙箱已卸载/终止'), false);
    }
    this.slots.clear();
    this.responders.clear();
  }

  get activeCount(): number {
    return this.slots.size;
  }
}

/** 默认 worker 工厂：浏览器/WebView 环境的真实 Web Worker（module worker） */
export function defaultWorkerFactory(url: string): WorkerLike {
  const w = new Worker(url, { type: 'module' });
  // 内部引用，让 WorkerLike.onmessage 与原生 Worker 的 MessageEvent 桥接
  const like: WorkerLike = {
    postMessage: (msg: HostToWorker) => w.postMessage(msg),
    terminate: () => w.terminate(),
    onmessage: null,
    onerror: null,
  };
  w.onmessage = (e: MessageEvent<WorkerToHost>) => {
    like.onmessage?.({ data: e.data });
  };
  w.onerror = (e: ErrorEvent) => {
    like.onerror?.({ message: e.message });
  };
  return like;
}

/** 把 runtime 源码包装为 Blob URL（module worker 入口） */
export function createRuntimeUrl(): string {
  return URL.createObjectURL(
    new Blob([SANDBOX_RUNTIME_SRC], { type: 'text/javascript' }),
  );
}

/**
 * 把「真实 ExecContext + nodeId」适配为 CapabilityResponder。
 * worker 内 ctx.llm/storage/logger 等请求落到宿主真实 ctx 上执行。
 * 注意：worker 内 onToken 流式在 PoC 阶段暂不通（llm 非流式），见设计 §3.3。
 */
export function execContextResponder(ctx: ExecContext): CapabilityResponder {
  return async (method, args) => {
    const [a0, a1, a2, a3] = args as [unknown?, unknown?, unknown?, unknown?];
    switch (method) {
      case 'logger.info':
        ctx.logger.info(String(a0 ?? ''));
        return undefined;
      case 'logger.warn':
        ctx.logger.warn(String(a0 ?? ''));
        return undefined;
      case 'logger.error':
        ctx.logger.error(String(a0 ?? ''));
        return undefined;
      case 'reportCost':
        ctx.reportCost(a0 as CostRecord);
        return undefined;
      case 'setPartial':
        ctx.setPartial(String(a0), a1);
        return undefined;
      case 'setBranches':
        ctx.setBranches?.((a0 as string[]) ?? []);
        return undefined;
      case 'llm':
        return ctx.llm(
          String(a0),
          (a1 as Parameters<ExecContext['llm']>[1]) ?? [],
          undefined,
          a2 as string | undefined,
          a3 as string[] | undefined,
        );
      case 'storage.get':
        return ctx.storage.get(String(a0));
      case 'storage.set':
        await ctx.storage.set(String(a0), String(a1 ?? ''));
        return undefined;
      case 'addAsset':
        ctx.addAsset(a0 as Parameters<ExecContext['addAsset']>[0]);
        return undefined;
      case 'writeOutEdgeScope':
        ctx.writeOutEdgeScope?.(String(a0), (a1 as string[]) ?? []);
        return undefined;
      case 'sandbox.writeFile':
        return ctx.sandbox?.writeFile(String(a0), String(a1 ?? '')) ?? Promise.resolve('no-sandbox');
      case 'sandbox.readFrom':
        return ctx.sandbox?.readFrom(String(a0), String(a1)) ?? Promise.resolve(null);
      case 'sandbox.list':
        return ctx.sandbox?.list(String(a0)) ?? Promise.resolve([]);
      case 'sandbox.commitAll':
        return ctx.sandbox?.commitAll() ?? Promise.resolve([]);
      case 'sandbox.commitLanes':
        return ctx.sandbox?.commitLanes((a0 as string[]) ?? []) ?? Promise.resolve([]);
      case 'intervene': {
        const intervene = ctx.intervene;
        if (!intervene) return { kind: 'cancelled', error: '宿主未启用接管能力' };
        return intervene(a0 as Parameters<NonNullable<ExecContext['intervene']>>[0]);
      }
      default:
        throw new Error(`未知能力方法：${method}`);
    }
  };
}

/**
 * 组装沙箱节点的 NodeExecuteFn：
 * - 生成每次执行的唯一 executionId，按它注册/注销 responder（避免并发覆盖）；
 * - 把 executor 构造的真实 ctx（含 nodeId）透传给沙箱；
 * - 浏览器无 Worker 时回退现有直接执行（保底路径，Node/headless 可用）。
 */
export function createSandboxedNodeExecute(
  manager: SandboxManager,
  pluginId: string,
  entryCode: string,
  capability: CapabilityLevel,
  typeId: string,
  fallback: NodeExecuteFn,
): NodeExecuteFn {
  return async (inputs, params, ctx) => {
    if (typeof Worker === 'undefined') {
      return fallback(inputs, params, ctx);
    }
    const executionId = `ex-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    manager.registerResponder(executionId, execContextResponder(ctx));
    try {
      return await manager.execute(pluginId, entryCode, {
        executionId,
        typeId,
        inputs,
        params,
        capability,
        nodeId: ctx.nodeId ?? '',
        vars: ctx.vars,
        costLog: ctx.costLog,
        signal: ctx.signal,
      });
    } finally {
      manager.unregisterResponder(executionId);
    }
  };
}
