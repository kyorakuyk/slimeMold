/**
 * H2 PoC：沙箱插件 RPC 协议类型定义（主线程 ⇄ Web Worker 双向消息）。
 *
 * 设计见 docs/H2_PLUGIN_ISOLATION_DESIGN.md §3.2。
 * 所有消息为 JSON 可序列化对象；请求-响应以 `id` 关联。
 */

import type { CapabilityLevel, CostRecord } from '../../types';

/** 宿主 → worker */
export type HostToWorker =
  | {
      kind: 'load-plugin';
      pluginId: string;
      /** 插件入口源码（index.js ESM），worker 内经 Blob URL 动态 import() */
      entryCode: string;
    }
  | {
      kind: 'execute';
      id: string;
      typeId: string;
      inputs: Record<string, unknown>;
      params: Record<string, unknown>;
      capability: CapabilityLevel;
      /** ctx.vars 快照（同步读取，postMessage 无法同步往返） */
      vars: Record<string, unknown>;
      /** ctx.costLog 快照（同理） */
      costLog: CostRecord[];
    }
  | { kind: 'capability:response'; id: string; ok: true; value: unknown }
  | { kind: 'capability:response'; id: string; ok: false; error: string }
  | { kind: 'abort'; runId: string }
  | { kind: 'terminate' };

/** worker → 宿主 */
export type WorkerToHost =
  | { kind: 'ready'; pluginId: string }
  | { kind: 'load-error'; pluginId: string; error: string }
  | { kind: 'execute:result'; id: string; outputs: Record<string, unknown> }
  | { kind: 'execute:error'; id: string; error: string; stack?: string }
  | {
      kind: 'capability:request';
      id: string;
      method: CapabilityMethod;
      args: unknown[];
    }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'cost'; record: CostRecord }
  | { kind: 'partial'; key: string; value: unknown }
  | { kind: 'heartbeat'; runId: string };

/** ExecContext 能力方法枚举（对齐 src/types.ts ExecContext 字段） */
export type CapabilityMethod =
  | 'logger.info'
  | 'logger.warn'
  | 'logger.error'
  | 'reportCost'
  | 'setPartial'
  | 'setBranches'
  | 'llm'
  | 'llm:onToken'
  | 'storage.get'
  | 'storage.set'
  | 'addAsset'
  | 'writeOutEdgeScope'
  | 'sandbox.writeFile'
  | 'sandbox.readFrom'
  | 'sandbox.list'
  | 'sandbox.commitAll'
  | 'sandbox.commitLanes'
  | 'intervene';

/** 宿主对一次 execute 的响应：成功输出 / 失败错误 */
export type ExecuteResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; error: string; stack?: string };
