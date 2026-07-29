import type { NodeDefinition } from '../types';
import { httpFetch } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';

/** 将模板中的 {{key}} 替换为 inputs/params 值 */
function renderTemplate(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

const textInput: NodeDefinition = {
  typeId: 'input.text',
  name: '文本输入',
  category: '输入',
  description: '提供固定文本，作为工作流的起点数据源',
  inputs: [],
  outputs: [{ id: 'text', label: '文本' }],
  params: [
    {
      key: 'text',
      label: '内容',
      type: 'textarea',
      default: '',
      placeholder: '输入要传递给下游节点的文本…',
    },
  ],
  async execute(_inputs, params) {
    return { text: String(params.text ?? '') };
  },
};

const agentChat: NodeDefinition = {
  typeId: 'agent.chat',
  name: '智能体',
  category: '智能体',
  description: '调用绑定的智能体（多协议 LLM）处理输入文本',
  inputs: [{ id: 'prompt', label: '提示词' }],
  outputs: [{ id: 'text', label: '回复' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    {
      key: 'system',
      label: '系统提示词',
      type: 'textarea',
      default: '',
      placeholder: '可选，设定智能体角色与行为…',
    },
  ],
  async execute(inputs, params, ctx) {
    const agentId = String(params.agentId ?? '');
    if (!agentId) throw new Error('未绑定智能体，请在右侧面板选择');
    const prompt = String(inputs.prompt ?? '');
    if (!prompt) throw new Error('缺少输入提示词（prompt 端口未接入数据）');
    const messages = [];
    const system = String(params.system ?? '').trim();
    if (system) messages.push({ role: 'system' as const, content: system });
    messages.push({ role: 'user' as const, content: prompt });
    ctx.logger.info(`智能体请求，prompt ${prompt.length} 字`);
    const text = await ctx.llm(agentId, messages);
    return { text };
  },
};

const template: NodeDefinition = {
  typeId: 'text.template',
  name: '模板拼接',
  category: '文本',
  description: '用 {{a}} {{b}} 占位符将多路输入拼装为一段文本',
  inputs: [
    { id: 'a', label: '输入 A' },
    { id: 'b', label: '输入 B' },
  ],
  outputs: [{ id: 'text', label: '文本' }],
  params: [
    {
      key: 'template',
      label: '模板',
      type: 'textarea',
      default: '{{a}}\n{{b}}',
      placeholder: '使用 {{a}}、{{b}} 引用输入端口…',
    },
  ],
  async execute(inputs, params) {
    return {
      text: renderTemplate(String(params.template ?? ''), inputs),
    };
  },
};

const httpRequest: NodeDefinition = {
  typeId: 'tool.http',
  name: 'HTTP 请求',
  category: '工具',
  description: '发起 HTTP 请求，URL 支持 {{url}} 端口注入',
  inputs: [{ id: 'url', label: 'URL(可选)' }],
  outputs: [{ id: 'body', label: '响应体' }],
  params: [
    { key: 'url', label: 'URL', type: 'text', default: '', placeholder: 'https://…' },
    {
      key: 'method',
      label: '方法',
      type: 'select',
      default: 'GET',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
      ],
    },
    { key: 'body', label: '请求体(POST)', type: 'textarea', default: '' },
  ],
  async execute(inputs, params, ctx) {
    const url = String(inputs.url ?? params.url ?? '').trim();
    if (!url) throw new Error('URL 为空');
    const method = String(params.method ?? 'GET');
    ctx.logger.info(`${method} ${url}`);
    const res = await httpFetch(url, {
      method,
      signal: ctx.signal,
      ...(method === 'POST'
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: String(params.body ?? ''),
          }
        : {}),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    return { body };
  },
};

const preview: NodeDefinition = {
  typeId: 'output.preview',
  name: '结果预览',
  category: '输出',
  description: '展示上游节点的输出结果，作为工作流终点',
  inputs: [{ id: 'value', label: '数据' }],
  outputs: [],
  params: [],
  async execute(inputs) {
    return { value: inputs.value };
  },
};

export const builtinDefs: NodeDefinition[] = [
  textInput,
  agentChat,
  template,
  httpRequest,
  preview,
];

export function registerBuiltins(): void {
  useRegistryStore.getState().register(builtinDefs);
}
