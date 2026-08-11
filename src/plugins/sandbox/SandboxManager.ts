/**
 * H2 PoC：沙箱插件宿主管理器（主线程侧）。
 *
 * 职责：
 * - 按 pluginId 建立/复用 Web Worker（worker 内跑 runtime.ts 引导脚本）；
 * - `execute`：把插件节点调用封装为 postMessage 请求-响应（带超时）；
 * - 能力代理：worker 内 ctx 的 llm/storage/logger 等请求由宿主侧真实 ExecContext 响应；
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

/** 默认单次 execute 超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 60_000;

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
    resolve: (o: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  };
}

export class SandboxManager {
  private slots = new Map<string, WorkerSlot>();
  private responders = new Map<string, CapabilityResponder>();
  private makeWorker: WorkerFactory;
  private defaultTimeoutMs: number;

  constructor(opts?: { workerFactory?: WorkerFactory; timeoutMs?: number }) {
    this.makeWorker = opts?.workerFactory ?? defaultWorkerFactory;
    this.defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const id = `ex-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const runId = `run-${Date.now()}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.current = undefined;
        this.killSlot(slot, true);
        reject(new Error(`插件执行超时（${timeoutMs}ms）：${params.typeId}`));
      }, timeoutMs);
      slot.current = {
        resolve: (o) => {
          clearTimeout(timer);
          slot.current = undefined;
          resolve(o);
        },
        reject: (e) => {
          clearTimeout(timer);
          slot.current = undefined;
          reject(e);
        },
      };
      // 取消：宿主 signal abort → 转发 abort 消息（worker 内 ctx.signal 触发）
      if (params.signal) {
        const onAbort = () => {
          slot.worker.postMessage({ kind: 'abort', runId });
        };
        if (params.signal.aborted) onAbort();
        else params.signal.addEventListener('abort', onAbort, { once: true });
      }
      slot.worker.postMessage({
        kind: 'execute',
        id,
        typeId: params.typeId,
        inputs: params.inputs,
        params: params.params,
        capability: params.capability,
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
        const responder = this.responders.get(slot.pluginId);
        if (!responder) {
          slot.worker.postMessage({
            kind: 'capability:response',
            id: m.id,
            ok: false,
            error: `宿主未为插件 ${slot.pluginId} 注册能力处理器`,
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
      default:
        // log / cost / partial / ready / load-error / heartbeat：PoC 阶段宿主按需消费
        break;
    }
  }

  /** worker 崩溃：reject 当前执行 + 销毁槽位（下次 execute 自动重建） */
  private onWorkerError(slot: WorkerSlot, ev: { message?: string }): void {
    slot.current?.reject(new Error(`插件沙箱崩溃：${ev.message ?? '未知错误'}`));
    this.killSlot(slot, true);
  }

  private killSlot(slot: WorkerSlot, rebuild: boolean): void {
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      /* ignore */
    }
    if (rebuild) this.slots.delete(slot.pluginId);
  }

  /** 注册某插件的能力处理器（把能力映射到真实 ExecContext） */
  registerResponder(pluginId: string, responder: CapabilityResponder): void {
    this.responders.set(pluginId, responder);
  }

  unregisterResponder(pluginId: string): void {
    this.responders.delete(pluginId);
  }

  /** 终止所有沙箱（卸载插件 / 切换项目时调用） */
  terminateAll(): void {
    for (const slot of this.slots.values()) {
      this.killSlot(slot, false);
    }
    this.slots.clear();
  }

  get activeCount(): number {
    return this.slots.size;
  }
}

/** 默认 worker 工厂：浏览器/WebView 环境的真实 Web Worker（module worker） */
export function defaultWorkerFactory(url: string): WorkerLike {
  const w = new Worker(url, { type: 'module' });
  return {
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => w.terminate(),
    onmessage: (ev) => {
      w.onmessage = ev as MessageEvent<WorkerToHost>;
    },
    onerror: (ev) => {
      w.onerror = ev as ErrorEvent;
    },
  } as unknown as WorkerLike;
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
      case 'intervene':
        if (!ctx.intervene) return { kind: 'cancelled', error: '宿主未启用接管能力' };
        return ctx.intervene(a0 as Parameters<ExecContext['intervene']>[0]);
      default:
        throw new Error(`未知能力方法：${method}`);
    }
  };
}

/**
 * 组装沙箱节点的 NodeExecuteFn：
 * 把 executor 构造的真实 ctx 透传给沙箱，返回与普通节点一致的 execute 签名。
 * 浏览器无 Worker 时回退现有直接执行（保底路径，Node/headless 可用）。
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
    manager.registerResponder(pluginId, execContextResponder(ctx));
    try {
      return await manager.execute(pluginId, entryCode, {
        typeId,
        inputs,
        params,
        capability,
        nodeId: '',
        vars: ctx.vars,
        costLog: ctx.costLog,
        signal: ctx.signal,
      });
    } finally {
      manager.unregisterResponder(pluginId);
    }
  };
}
