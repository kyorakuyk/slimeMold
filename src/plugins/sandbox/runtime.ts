/**
 * H2 PoC：Web Worker 内引导脚本源码（纯 JS 字符串，经 Blob URL 创建 module worker）。
 *
 * 职责（运行在 worker 作用域，无 window/DOM/宿主闭包）：
 * - 接收宿主 `load-plugin`，把插件入口源码经 Blob URL 动态 import() 成模块；
 * - 接收宿主 `execute`，调用插件节点的 executor，构造「受限 ctx 代理」；
 * - ctx 代理把 llm/storage/logger 等能力转成 postMessage 请求，await 宿主回包；
 * - 单向事件（log/cost/partial/setBranches）直接 postMessage（fire-and-forget）；
 * - 收到宿主 `abort` → 触发 AbortController（映射到 ctx.signal）。
 *
 * 注意：worker 内无法 import 宿主 TS 类型，此文件为字符串源；能力方法名与
 * protocol.ts 的 CapabilityMethod 对齐（宿主角度的节点上下文经 nodeId 关联）。
 */

export const SANDBOX_RUNTIME_SRC = `// SlimeMold H2 PoC sandbox runtime（worker 内）
'use strict';

/** 插件模块（import 后缓存，避免每次 execute 重复加载） */
let pluginModule = null;
/** 插件入口的 executor 映射：{ [typeId]: fn } */
let executors = {};
/** 类式职业导出（PoC 阶段仅支持函数式 executors，类式留 P1+） */
let classRoot = null;

/** 正在执行的 execute 关联：id -> { resolve, reject, nodeId } */
const pendingExec = new Map();
/** 宿主能力请求关联：capId -> { resolve, reject } */
const pendingCap = new Map();
/** 当前 execute 的中止控制器（一次一个 execute，串行） */
let abortController = null;
let currentExecId = null;

function post(msg) {
  self.postMessage(msg);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.kind === 'load-plugin') {
      const url = URL.createObjectURL(new Blob([msg.entryCode], { type: 'text/javascript' }));
      try {
        const mod = await import(/* @vite-ignore */ url);
        pluginModule = mod;
        const root = mod.default && typeof mod.default === 'object' ? mod.default : mod;
        executors = root.executors || {};
        classRoot = root;
        post({ kind: 'ready', pluginId: msg.pluginId });
      } catch (err) {
        post({ kind: 'load-error', pluginId: msg.pluginId, error: String(err && err.message || err) });
      } finally {
        URL.revokeObjectURL(url);
      }
      return;
    }

    if (msg.kind === 'execute') {
      // 单 worker 串行执行：若已有在途执行，先拒绝（PoC 简化；并发留 P2）
      if (currentExecId) {
        post({
          kind: 'execute:error',
          id: msg.id,
          error: '沙箱当前正在执行另一个节点，暂不支持并发（PoC 限制）',
        });
        return;
      }
      currentExecId = msg.id;
      abortController = new AbortController();
      const p = new Promise((resolve, reject) => {
        pendingExec.set(msg.id, { resolve, reject, nodeId: msg.nodeId });
      });
      (async () => {
        const fn = executors[msg.typeId];
        if (typeof fn !== 'function') {
          throw new Error('插件未提供 executor：' + msg.typeId);
        }
        const ctx = makeCtx(msg);
        const outputs = await fn(msg.inputs || {}, msg.params || {}, ctx);
        post({ kind: 'execute:result', id: msg.id, outputs: outputs || {} });
      })().catch((err) => {
        post({
          kind: 'execute:error',
          id: msg.id,
          error: String(err && err.message || err),
          stack: err && err.stack,
        });
      }).finally(() => {
        pendingExec.delete(msg.id);
        currentExecId = null;
        abortController = null;
      });
      await p;
      return;
    }

    if (msg.kind === 'abort') {
      if (abortController) abortController.abort();
      return;
    }

    if (msg.kind === 'capability:response') {
      const p = pendingCap.get(msg.id);
      if (!p) return;
      pendingCap.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      return;
    }
  } catch (err) {
    post({
      kind: 'execute:error',
      id: msg && msg.kind === 'execute' ? msg.id : (currentExecId || ''),
      error: String(err && err.message || err),
      stack: err && err.stack,
    });
  }
};

/** 双向能力请求：postMessage + await 宿主回包 */
function cap(method, args, nodeId) {
  return new Promise((resolve, reject) => {
    const id = 'cap-' + Math.random().toString(36).slice(2) + Date.now();
    pendingCap.set(id, { resolve, reject });
    post({ kind: 'capability:request', id, method, args: args || [], nodeId: nodeId || (currentExecId || '') });
  });
}

/** 构造受限 ctx：能力转 postMessage 代理 */
function makeCtx(execMsg) {
  const nodeId = execMsg.nodeId || '';
  const vars = execMsg.vars || {};
  const costLog = execMsg.costLog || [];
  const req = (method, args) => cap(method, args, nodeId);
  const log = (level) => (message) => post({ kind: 'log', level, message: String(message) });

  const ctx = {
    logger: {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    vars,
    costLog,
    signal: abortController ? abortController.signal : (new AbortController()).signal,
    reportCost: (record) => post({ kind: 'cost', record: record || {} }),
    setPartial: (key, value) => post({ kind: 'partial', key: String(key), value }),
    setBranches: (handles) => post({ kind: 'capability:request', id: 'sb-' + Math.random().toString(36).slice(2), method: 'setBranches', args: [handles], nodeId }),
    storage: {
      get: (key) => req('storage.get', [key]),
      set: (key, value) => req('storage.set', [key, value]),
    },
    llm: (agentId, messages, onToken, modelOverride, toolNames) =>
      // PoC：非流式（onToken 暂不回传，P1 经 llm:onToken 接通）
      req('llm', [agentId, messages, modelOverride, toolNames]),
  };
  // 资产/沙箱/接管能力：按等级由宿主侧决定是否响应（worker 侧只声明方法）
  ctx.addAsset = (meta) => req('addAsset', [meta]);
  ctx.writeOutEdgeScope = (handle, scope) => req('writeOutEdgeScope', [handle, scope]);
  ctx.intervene = (request) => req('intervene', [request]);
  ctx.sandbox = {
    writeFile: (f, c) => req('sandbox.writeFile', [f, c]),
    readFrom: (o, f) => req('sandbox.readFrom', [o, f]),
    list: (o) => req('sandbox.list', [o]),
    commitAll: () => req('sandbox.commitAll', []),
    commitLanes: (lanes) => req('sandbox.commitLanes', [lanes]),
  };
  ctx.assets = [];
  return ctx;
}
`;
