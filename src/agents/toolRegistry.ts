/**
 * ToolRegistry —— 工具作为一等公民，与节点解耦。
 *
 * 设计要点：
 * - 一套工具定义 { name, description, parameters, execute } 存于字典，LLM 节点按名引用
 *   （节点 params.toolNames: string[]），不再把"写文件/搜索/读文件"硬编码进单个节点。
 * - execute(input, ctx) 与节点 execute 共用同一 ctx 契约（logger / storage / signal /
 *   sandbox 等），因此工具可被 harness 的 tool_call 循环直接调用，也可被普通节点复用。
 * - 复用 registryStore 的「字典 + register/unregister」思路，但存储对象为 ToolDefinition。
 * - 内置工具（writeFile / readFile / search）由现有 tool.* 节点的逻辑下沉而来，避免重复实现。
 *
 * 与 registryStore 的区别：registryStore 管「节点定义（NodeDefinition）」，ToolRegistry
 * 管「工具（ToolDefinition）」。节点是图上的可见单元；工具是 LLM 可调用的能力原语。
 */

import type { LLMToolSpec, ExecContext } from '../types';

/** 工具执行上下文：复用节点 execute 的 ctx 契约的精简子集（避免引入整张图依赖） */
export interface ToolContext {
  logger: ExecContext['logger'];
  storage: ExecContext['storage'];
  signal: AbortSignal;
  sandbox?: ExecContext['sandbox'];
  /** 当前工作区根目录（落盘用）；浏览器环境为 undefined */
  workspaceDir?: string;
}

/**
 * 注意：为避免循环依赖（builtin.ts → harness.ts → toolRegistry.ts），
 * 内置工具的注册不在此处 import，而由 builtin.ts 在其末尾调用
 * toolRegistry.register(builtinTools) 完成。本文件只定义工具字典 API，
 * 不反向依赖任何节点模块。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 对象，描述 execute 入参；同时作为 LLM tool_calls 的 parameters */
  parameters: Record<string, unknown>;
  /**
   * 工具执行体。input 为 harness 解析后的对象（模型给出的 JSON 参数）。
   * 返回任意可序列化结果，harness 会把它回写为 tool 消息的 content。
   * 抛错视为逻辑错误（不可重试），由 harness 捕获并回写 error 文本给模型。
   */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** 来源标记：'builtin' 内置 | 'plugin' 插件注册 | 'custom' 自定义节点注入 */
  source?: 'builtin' | 'plugin' | 'custom';
}

interface ToolRegistryState {
  tools: Record<string, ToolDefinition>;
  register: (defs: ToolDefinition[]) => void;
  unregister: (names: string[]) => void;
  get: (name: string) => ToolDefinition | undefined;
  list: () => ToolDefinition[];
  /** 转换为 provider 可用的 LLMToolSpec[]（仅含模型需要的 name/description/parameters） */
  toSpecs: (names?: string[]) => LLMToolSpec[];
}

const state: ToolRegistryState = {
  tools: {},
  register(defs) {
    for (const d of defs) state.tools[d.name] = d;
  },
  unregister(names) {
    for (const n of names) delete state.tools[n];
  },
  get(name) {
    return state.tools[name];
  },
  list() {
    return Object.values(state.tools);
  },
  toSpecs(names) {
    const picked = names && names.length ? names.map((n) => state.tools[n]).filter(Boolean) : state.list();
    return picked.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  },
};

/** 单例访问（同步，与 registryStore 习惯一致） */
export const toolRegistry = {
  register: state.register,
  unregister: state.unregister,
  get: state.get,
  list: state.list,
  toSpecs: state.toSpecs,
};

/* ------------------------------------------------------------------ */
/* 内置工具注册见 builtin.ts 末尾：toolRegistry.register(builtinTools)。  */
/* 此处不 import builtinTools，以避免 builtin → harness → toolRegistry   */
/* → builtin 的循环依赖。                                                */
/* ------------------------------------------------------------------ */

export type { ToolRegistryState };
