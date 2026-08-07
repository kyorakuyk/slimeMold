import { createNodeDef, type NodeDefinition } from '../../types';
import { renderTemplate } from '../builtinHelpers';

const template: NodeDefinition = {
  typeId: 'text.template',
  name: '模板拼接',
  category: '文本',
  description: '用 {{a}} {{b}} 占位符将多路输入拼装为一段文本',
  inputs: [
    { id: 'a', label: '输入 A', type: 'text' },
    { id: 'b', label: '输入 B', type: 'text' },
  ],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: [
    {
      key: 'template',
      label: '模板',
      type: 'textarea',
      default: '{{a}}\n{{b}}',
      placeholder: '使用 {{a}}、{{b}} 引用输入端口…',
    },
  ],
  async execute(inputs, params, ctx) {
    return {
      text: renderTemplate(String(params.template ?? ''), { ...ctx.vars, ...inputs }),
    };
  },
};

const preview: NodeDefinition = {
  typeId: 'output.preview',
  name: '结果预览',
  category: '输出',
  role: 'observer',
  whenToUse: '作为工作流终点，实时展示结果；开发调试时优先用于观察中间产物。',
  description: '展示上游节点的输出结果，作为工作流终点',
  inputs: [{ id: 'value', label: '数据', type: 'any' }],
  outputs: [],
  params: [],
  async execute(inputs) {
    return { value: inputs.value };
  },
};

const textOutput: NodeDefinition = {
  typeId: 'output.text',
  name: '文本输出',
  category: '输出',
  description: '将上游输出的文字内容完整展示在节点卡片上，支持一键复制，作为工作流终点',
  inputs: [{ id: 'text', label: '文本', type: 'any' }],
  outputs: [],
  params: [],
  async execute(inputs) {
    return { value: inputs.text };
  },
};

const listNode: NodeDefinition = {
  typeId: 'flow.list',
  name: '构造列表',
  category: '流程',
  description: '将文本按分隔方式拆分为数组 items，供循环批处理 / 合并文本节点使用',
  inputs: [],
  outputs: [{ id: 'items', label: '列表', type: 'list' }],
  params: [
    {
      key: 'text',
      label: '文本',
      type: 'textarea',
      default: '',
      placeholder: '每行一个元素…',
    },
    {
      key: 'split',
      label: '分隔方式',
      type: 'select',
      default: 'newline',
      options: [
        { label: '换行', value: 'newline' },
        { label: '逗号', value: 'comma' },
        { label: '空格', value: 'space' },
        { label: '指定字符', value: 'char' },
      ],
    },
    { key: 'sep', label: '分隔字符（分隔方式=指定字符 时生效）', type: 'text', default: ',' },
  ],
  async execute(_inputs, params) {
    const text = String(params.text ?? '');
    const split = String(params.split ?? 'newline');
    let items: string[];
    if (split === 'newline') items = text.split(/\r?\n/);
    else if (split === 'comma') items = text.split(',');
    else if (split === 'space') items = text.split(/\s+/);
    else items = text.split(String(params.sep ?? ','));
    items = items.map((s) => s.trim()).filter((s) => s.length > 0);
    return { items };
  },
};

const mapNode: NodeDefinition = {
  typeId: 'flow.map',
  name: '循环批处理',
  category: '流程',
  description:
    '对输入 items 数组逐项处理，输出 results 数组。支持「模板」模式（{{item}}/{{index}} 渲染）或「智能体」模式（逐项调用 LLM）',
  inputs: [{ id: 'items', label: '列表', type: 'list' }],
  outputs: [{ id: 'results', label: '结果', type: 'list' }],
  params: [
    {
      key: 'mode',
      label: '处理模式',
      type: 'select',
      default: 'template',
      options: [
        { label: '模板', value: 'template' },
        { label: '智能体', value: 'agent' },
      ],
    },
    {
      key: 'template',
      label: '模板（{{item}} 当前项 / {{index}} 序号）',
      type: 'textarea',
      default: '{{item}}',
      placeholder: '例如：第{{index}}项：{{item}}',
    },
    { key: 'agentId', label: '智能体（智能体模式）', type: 'agent', default: '' },
    {
      key: 'prompt',
      label: '提示词模板（{{item}} 为当前项）',
      type: 'textarea',
      default: '',
      placeholder: '请处理：{{item}}',
    },
  ],
  async execute(inputs, params, ctx) {
    const raw = inputs.items;
    const arr: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : [];
    const mode = String(params.mode ?? 'template');
    const results: unknown[] = [];
    if (mode === 'agent') {
      const agentId = String(params.agentId ?? '');
      if (!agentId) throw new Error('未绑定智能体，请在右侧面板选择');
      const promptTpl = String(params.prompt ?? '{{item}}');
      let idx = 0;
      for (const item of arr) {
        if (ctx.signal.aborted) throw new Error('已中止');
        const prompt = renderTemplate(promptTpl, { ...ctx.vars, item, index: idx });
        let acc = '';
        const text = await ctx.llm(
          agentId,
          [{ role: 'user', content: prompt }],
          (d) => {
            acc += d;
            ctx.setPartial('results', [...results, acc]);
          },
        );
        results.push(acc || text);
        ctx.setPartial('results', [...results]);
        idx++;
      }
    } else {
      const tpl = String(params.template ?? '{{item}}');
      let idx = 0;
      for (const item of arr) {
        if (ctx.signal.aborted) throw new Error('已中止');
        results.push(renderTemplate(tpl, { ...ctx.vars, item, index: idx }));
        ctx.setPartial('results', [...results]);
        idx++;
      }
    }
    return { results };
  },
};

const joinNode: NodeDefinition = {
  typeId: 'flow.join',
  name: '合并文本',
  category: '流程',
  description: '将数组 items 用分隔符拼接为文本 text',
  inputs: [{ id: 'items', label: '列表', type: 'list' }],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: [{ key: 'sep', label: '分隔符', type: 'text', default: '\n' }],
  async execute(inputs, params) {
    const arr = Array.isArray(inputs.items) ? inputs.items : [];
    const sep = String(params.sep ?? '\n');
    const text = arr
      .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')))
      .join(sep);
    return { text };
  },
};

export const textNodes: NodeDefinition[] = [
  template,
  preview,
  textOutput,
  listNode,
  mapNode,
  joinNode,
].map(createNodeDef);
