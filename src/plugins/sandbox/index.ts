/**
 * H2 PoC：沙箱插件执行后端（Web Worker）。
 *
 * 全局单例 SandboxManager——loader.ts 在组装插件 defs 时若开启沙箱，
 * 用 createSandboxedNodeExecute 包装 execute，使插件节点在 Worker 内执行。
 * 未开启沙箱时保持现有主线程 Blob import 路径不变。
 */

import { SandboxManager } from './SandboxManager';

export { SandboxManager } from './SandboxManager';
export { createSandboxedNodeExecute } from './SandboxManager';
export { execContextResponder } from './SandboxManager';
export type { WorkerLike, WorkerFactory, SandboxExecuteParams, CapabilityResponder } from './SandboxManager';
export { DEFAULT_TIMEOUT_MS } from './SandboxManager';
export type { CapabilityMethod, HostToWorker, WorkerToHost } from './protocol';
export { CAPABILITY_WHITELIST, isCapabilityAllowed, allowedMethodsFor } from './protocol';

/** 全局单例：跨插件复用 worker 池 */
export const sandboxManager = new SandboxManager();
