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
 * 安全（Codex P0 修复）：
 * - 按 execute 消息携带的 capability 等级，只把白名单内的方法挂到 ctx 上；
 *   越权方法键为 undefined——插件调用即 TypeError（结构性越权不存在）。
 * - 能力请求携带 executionId + nodeId，宿主按 executionId 路由 responder。
 *
 * 注意：worker 内无法 import 宿主 TS 类型，此文件为字符串源；能力方法名与
 * protocol.ts 的 CapabilityMethod 对齐（白名单集合与宿主侧保持同步）。
 */

export const SANDBOX_RUNTIME_SRC = `// SlimeMold H2 PoC sandbox runtime（worker 内）
'use strict';

/** 插件模块（import 后缓存，避免每次 execute 重复加载） */
let pluginModule = null;
/** 插件入口的 executor 映射：{ [typeId]: fn } */
let executors = {};
/** 类式职业导出（PoC 阶段仅支持函数式 executors，类式留 P1+） */
let classRoot = null;

/** 正在执行的 execute 关联：id -> { resolve, reject } */
const pendingExec = new Map();
/** 宿主能力请求关联：capId -> { resolve, reject } */
const pendingCap = new Map();
/** 当前 execute 的中止控制器（一次一个 execute，串行） */
let abortController = null;
let currentExecId = null;
let currentNodeId = '';

/** 能力白名单（与宿主侧 protocol.CAPABILITY_WHITELIST 同步；越权键保持 undefined） */
var WHITELIST = {
  compute: ['logger.info', 'logger.warn', 'logger.error', 'reportCost', 'setPartial', 'setBranches'],
  io: ['logger.info', 'logger.warn', 'logger.error', 'reportCost', 'setPartial', 'setBranches', 'llm', 'storage.get', 'storage.set', 'addAsset', 'writeOutEdgeScope'],
  sandbox_write: ['logger.info', 'logger.warn', 'logger.error', 'reportCost', 'setPartial', 'setBranches', 'llm', 'storage.get', 'storage.set', 'addAsset', 'writeOutEdgeScope', 'sandbox.writeFile', 'sandbox.readFrom', 'sandbox.list'],
  coordinator: ['logger.info', 'logger.warn', 'logger.error', 'reportCost', 'setPartial', 'setBranches', 'llm', 'storage.get', 'storage.set', 'addAsset', 'writeOutEdgeScope', 'sandbox.writeFile', 'sandbox.readFrom', 'sandbox.list', 'sandbox.commitAll', 'sandbox.commitLanes', 'intervene'],
  system: ['logger.info', 'logger.warn', 'logger.error', 'reportCost', 'setPartial', 'setBranches', 'llm', 'storage.get', 'storage.set', 'addAsset', 'writeOutEdgeScope', 'sandbox.writeFile', 'sandbox.readFrom', 'sandbox.list', 'sandbox.commitAll', 'sandbox.commitLanes', 'intervene'],
};

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
      currentNodeId = msg.nodeId || '';
      abortController = new AbortController();
      const p = new Promise((resolve, reject) => {
        pendingExec.set(msg.id, { resolve, reject });
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
        currentNodeId = '';
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

/** 双向能力请求：postMessage + await 宿主回包（带 executionId + nodeId） */
function cap(method, args) {
  return new Promise((resolve, reject) => {
    const id = 'cap-' + Math.random().toString(36).slice(2) + Date.now();
    pendingCap.set(id, { resolve, reject });
    post({ kind: 'capability:request', id, executionId: currentExecId || '', method, args: args || [], nodeId: currentNodeId });
  });
}

/** 构造受限 ctx：只挂白名单内的方法键（越权键 undefined → 插件调用即 TypeError） */
function makeCtx(execMsg) {
  const allowed = new Set(WHITELIST[execMsg.capability] || WHITELIST.compute);
  const nodeId = execMsg.nodeId || '';
  const vars = execMsg.vars || {};
  const costLog = execMsg.costLog || [];
  const req = (method, args) => cap(method, args);
  const log = (level) => (message) => post({ kind: 'log', level, message: String(message), nodeId });

  const ctx = {
    vars,
    costLog,
    signal: abortController ? abortController.signal : (new AbortController()).signal,
  };

  // logger / reportCost / setPartial / setBranches：基础能力（compute 即允许）
  if (allowed.has('logger.info')) ctx.logger = { info: log('info'), warn: log('warn'), error: log('error') };
  if (allowed.has('reportCost')) ctx.reportCost = (record) => post({ kind: 'cost', record: record || {}, nodeId });
  if (allowed.has('setPartial')) ctx.setPartial = (key, value) => post({ kind: 'partial', key: String(key), value, nodeId });
  if (allowed.has('setBranches')) {
    ctx.setBranches = (handles) => post({ kind: 'capability:request', id: 'sb-' + Math.random().toString(36).slice(2), executionId: currentExecId || '', method: 'setBranches', args: [handles], nodeId });
  }

  // io 级能力
  if (allowed.has('storage.get') || allowed.has('storage.set')) {
    ctx.storage = {
      get: (key) => req('storage.get', [key]),
      set: (key, value) => req('storage.set', [key, value]),
    };
  }
  if (allowed.has('llm')) {
    ctx.llm = (agentId, messages, onToken, modelOverride, toolNames) =>
      // PoC：非流式（onToken 暂不回传，P1 经 llm:onToken 接通）
      req('llm', [agentId, messages, modelOverride, toolNames]);
  }
  if (allowed.has('addAsset')) ctx.addAsset = (meta) => req('addAsset', [meta]);
  if (allowed.has('writeOutEdgeScope')) ctx.writeOutEdgeScope = (handle, scope) => req('writeOutEdgeScope', [handle, scope]);

  // sandbox_write / coordinator / system 级能力
  if (allowed.has('sandbox.writeFile') || allowed.has('sandbox.readFrom') || allowed.has('sandbox.list')) {
    ctx.sandbox = {
      writeFile: allowed.has('sandbox.writeFile') ? (f, c) => req('sandbox.writeFile', [f, c]) : undefined,
      readFrom: allowed.has('sandbox.readFrom') ? (o, f) => req('sandbox.readFrom', [o, f]) : undefined,
      list: allowed.has('sandbox.list') ? (o) => req('sandbox.list', [o]) : undefined,
      commitAll: allowed.has('sandbox.commitAll') ? () => req('sandbox.commitAll', []) : undefined,
      commitLanes: allowed.has('sandbox.commitLanes') ? (lanes) => req('sandbox.commitLanes', [lanes]) : undefined,
    };
  }
  if (allowed.has('intervene')) ctx.intervene = (request) => req('intervene', [request]);

  ctx.assets = [];
  return ctx;
}
`;
