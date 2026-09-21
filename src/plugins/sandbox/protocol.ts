/**
 * H2 PoC：沙箱插件 RPC 协议类型定义（主线程 ⇄ Web Worker 双向消息）。
 *
 * 设计见 docs/H2_PLUGIN_ISOLATION_DESIGN.md §3.2。
 * 所有消息为 JSON 可序列化对象；请求-响应以 `id` 关联。
 */

import type { CostRecord } from '../../types/agent';
import type { CapabilityLevel } from '../../types';

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
      /** 本次执行的唯一 id（宿主生成，作为请求-响应关联与 responder 路由键） */
      id: string;
      typeId: string;
      inputs: Record<string, unknown>;
      params: Record<string, unknown>;
      capability: CapabilityLevel;
      /** 节点 id（owner ?? id），用于日志/partial/能力调用的节点归属 */
      nodeId: string;
      /**
       * 本次执行允许的能力方法白名单（宿主从 CAPABILITY_WHITELIST[capability] 生成）。
       * worker 侧只消费此列表构造 ctx——避免 protocol 与 runtime 双份复制漂移（Codex P2）。
       */
      allowedMethods: CapabilityMethod[];
      /** ctx.vars 快照（同步读取，postMessage 无法同步往返） */
      vars: Record<string, unknown>;
      /** ctx.costLog 快照（同理） */
      costLog: CostRecord[];
    }
  | { kind: 'capability:response'; id: string; ok: true; value: unknown }
  | { kind: 'capability:response'; id: string; ok: false; error: string }
  | { kind: 'abort'; runId: string }
  /** 心跳探针：worker 须回 { kind:'heartbeat', runId }（死循环/卡死检测，Codex §4.3） */
  | { kind: 'ping'; runId: string }
  | { kind: 'terminate' };

/** worker → 宿主 */
export type WorkerToHost =
  | { kind: 'ready'; pluginId: string }
  | { kind: 'load-error'; pluginId: string; error: string }
  | { kind: 'execute:result'; id: string; outputs: Record<string, unknown> }
  | { kind: 'execute:error'; id: string; error: string; stack?: string }
  | {
      kind: 'capability:request';
      /** 能力请求 id（worker 内生成，用于关联响应） */
      id: string;
      /** 所属执行 id（execute 消息的 id），宿主据此路由到正确的 responder */
      executionId: string;
      method: CapabilityMethod;
      args: unknown[];
      /** 节点 id（归属） */
      nodeId: string;
    }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; nodeId: string }
  | { kind: 'cost'; record: CostRecord; nodeId: string }
  | { kind: 'partial'; key: string; value: unknown; nodeId: string }
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

/* ---------------- 能力白名单（对齐 executorHelpers.applyCapability 的等级语义） ---------------- */

/**
 * 各 CapabilityLevel 允许调用的能力方法集合（结构性强制的单一真相源）。
 * 与 executorHelpers.applyCapability 的裁剪点一致：
 * - compute：仅基础只读（logger/vars/signal/costLog/reportCost/setPartial/setBranches）
 * - io：+ llm / storage / addAsset / writeOutEdgeScope
 * - sandbox_write：+ sandbox 写副本（writeFile/readFrom/list），剥离 commitAll/commitLanes
 * - coordinator / system：+ 完整 commit 汇总权（commitAll/commitLanes / intervene）
 * 宿主侧（SandboxManager）据此拦截越权 RPC；worker 侧（runtime.ts）据此只挂白名单方法键。
 */
export const CAPABILITY_WHITELIST: Record<CapabilityLevel, ReadonlySet<CapabilityMethod>> = {
  compute: new Set([
    'logger.info',
    'logger.warn',
    'logger.error',
    'reportCost',
    'setPartial',
    'setBranches',
  ]),
  io: new Set([
    'logger.info',
    'logger.warn',
    'logger.error',
    'reportCost',
    'setPartial',
    'setBranches',
    'llm',
    'storage.get',
    'storage.set',
    'addAsset',
    'writeOutEdgeScope',
  ]),
  sandbox_write: new Set([
    'logger.info',
    'logger.warn',
    'logger.error',
    'reportCost',
    'setPartial',
    'setBranches',
    'llm',
    'storage.get',
    'storage.set',
    'addAsset',
    'writeOutEdgeScope',
    'sandbox.writeFile',
    'sandbox.readFrom',
    'sandbox.list',
  ]),
  coordinator: new Set([
    'logger.info',
    'logger.warn',
    'logger.error',
    'reportCost',
    'setPartial',
    'setBranches',
    'llm',
    'storage.get',
    'storage.set',
    'addAsset',
    'writeOutEdgeScope',
    'sandbox.writeFile',
    'sandbox.readFrom',
    'sandbox.list',
    'sandbox.commitAll',
    'sandbox.commitLanes',
    'intervene',
  ]),
  system: new Set([
    'logger.info',
    'logger.warn',
    'logger.error',
    'reportCost',
    'setPartial',
    'setBranches',
    'llm',
    'storage.get',
    'storage.set',
    'addAsset',
    'writeOutEdgeScope',
    'sandbox.writeFile',
    'sandbox.readFrom',
    'sandbox.list',
    'sandbox.commitAll',
    'sandbox.commitLanes',
    'intervene',
  ]),
};

/** 判断某能力方法是否在某等级下允许（宿主侧拦截用） */
export function isCapabilityAllowed(level: CapabilityLevel, method: CapabilityMethod): boolean {
  return CAPABILITY_WHITELIST[level].has(method);
}

/** 取某等级的允许方法列表（宿主侧生成，随 execute 消息下发给 worker） */
export function allowedMethodsFor(level: CapabilityLevel): CapabilityMethod[] {
  return [...CAPABILITY_WHITELIST[level]];
}
