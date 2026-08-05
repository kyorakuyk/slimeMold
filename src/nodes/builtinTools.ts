/**
 * builtinTools —— 内置工具定义，供 ToolRegistry 注册。
 *
 * 复用 builtin.ts 中 tool.* 节点的 execute（避免逻辑重复），并补上
 * LLM 所需的 JSON Schema parameters。节点仍是图上可见单元；工具是 LLM
 * 可调用能力原语，二者共用同一 ctx 契约。
 *
 * 注意：节点的 execute 签名是 (inputs, params, ctx)，而 ToolDefinition
 * 的 execute 是 (input, ctx)。这里做一层适配——
 *   - input 对应节点的 inputs（按端口 id 取）
 *   - params 固定用节点默认参数（工具场景下通常不需要用户调参）
 */

import type { NodeDefinition, NodeContext } from '../types';
import type { ToolDefinition, ToolContext } from '../agents/toolRegistry';

/**
 * 注意：本文件刻意「不」在模块顶层 import builtin.ts 的 builtinDefs，
 * 否则会形成 builtin.ts → builtinTools.ts → builtin.ts 的循环依赖，
 * 导致 builtinTools 顶层求值时 builtinDefs 仍处 TDZ，抛
 * ReferenceError: Cannot access 'builtinDefs' before initialization，
 * 整张模块图加载失败、React 永不挂载、UI 一直转圈。
 * 改为由 registerBuiltins 把已就绪的 builtinDefs 传进来（调用点已初始化完毕）。
 */

/** 节点 execute 的统一签名（与 NodeDefinition.execute 对齐） */
type NodeExecute = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: NodeContext,
) => Promise<Record<string, unknown>>;

function nodeByName(typeId: string): NodeDefinition | undefined {
  return builtinDefs.find((d) => d.typeId === typeId);
}

/** 把节点默认 params 提取成 { key: default } 形态 */
function defaultParams(def: NodeDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.params ?? []) out[p.key] = p.default;
  return out;
}

/** 把节点 execute 适配为工具 execute */
function adapt(def: NodeDefinition): ToolDefinition {
  const execute = def.execute as NodeExecute;
  const defaults = defaultParams(def);
  return {
    name: def.typeId,
    description: def.description ?? def.name,
    parameters: TOOL_SCHEMAS[def.typeId] ?? { type: 'object', properties: {} },
    source: 'builtin',
    async execute(input, ctx) {
      // 工具的 ctx 是精简版，需补全节点 execute 期望的字段
      const nodeCtx = ctx as unknown as NodeContext;
      nodeCtx.setPartial ??= () => {};
      nodeCtx.vars ??= {};
      const result = await execute(input, defaults, nodeCtx);
      // 工具返回结果直接作为 tool 消息 content（取首个输出端口值）
      const first = Object.values(result)[0];
      return first ?? result;
    },
  };
}

/** 各内置工具的 JSON Schema（供 LLM 理解参数） */
const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  'tool.writeFile': {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要写入文件的文本内容' },
      filename: { type: 'string', description: '文件名，留空或 auto 则自动推断' },
      hint: { type: 'string', description: '命名提示（可选）' },
    },
    required: ['content'],
  },
  'tool.http': {
    type: 'object',
    properties: {
      url: { type: 'string', description: '请求地址' },
      method: { type: 'string', description: 'HTTP 方法，默认 GET', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      body: { type: 'string', description: '请求体（POST/PUT 时）' },
    },
    required: ['url'],
  },
};

/**
 * 由 builtinDefs 构造内置工具列表（惰性，不在模块顶层求值）。
 * @param builtinDefs 已就绪的内置节点定义（由 registerBuiltins 传入，规避循环依赖 TDZ）
 */
export function makeBuiltinTools(builtinDefs: NodeDefinition[]): ToolDefinition[] {
  return [nodeByName('tool.writeFile'), nodeByName('tool.http')]
    .filter((d): d is NodeDefinition => !!d)
    .map(adapt);

  function nodeByName(typeId: string): NodeDefinition | undefined {
    return builtinDefs.find((d) => d.typeId === typeId);
  }
}
