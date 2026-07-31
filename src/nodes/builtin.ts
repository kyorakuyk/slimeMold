import type { NodeDefinition } from '../types';
import { httpFetch } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { evalExpr } from '../engine/expr';
import { findRole, resolveRoleSystem } from '../agents/agentManager';

/** 将模板中的 {{key}} 替换为 scope 中的值（对象会 JSON 序列化） */
function renderTemplate(
  template: string,
  scope: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = scope[key];
    return v === undefined || v === null
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  });
}

const textInput: NodeDefinition = {
  typeId: 'input.text',
  name: '文本输入',
  category: '输入',
  description: '提供固定文本，作为工作流的起点数据源',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
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
  description:
    '调用绑定的智能体（多协议 LLM）处理输入文本。可绑定角色库中的角色快速获得职业提示词，并支持节点级模型覆写与上下文隔离。',
  inputs: [{ id: 'prompt', label: '提示词', type: 'text' }],
  outputs: [{ id: 'text', label: '回复', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o-mini，覆写该次调用的模型',
    },
    {
      key: 'system',
      label: '系统提示词（覆盖角色）',
      type: 'textarea',
      default: '',
      placeholder: '可选；留空则使用所绑定角色的系统提示词',
    },
    {
      key: 'simulate',
      label: '离线模拟模式（不调 LLM，回显角色链路）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const agentId = String(params.agentId ?? '');
    const prompt = String(inputs.prompt ?? '');
    if (!prompt) throw new Error('缺少输入提示词（prompt 端口未接入数据）');

    const roleId = String(params.roleId ?? '');
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system = resolveRoleSystem(role, String(params.system ?? ''));

    // 节点级模型覆写：构造临时 AgentConfig，仅本次调用生效
    const modelOverride = String(params.modelOverride ?? '').trim();
    const isolated = role?.contextScope === 'isolated';

    // —— 离线模拟模式：不发起真实 LLM 调用，按角色链路回显，便于无模型时验证 ——
    if (String(params.simulate ?? 'off') === 'on') {
      const roleTag = role
        ? `${role.icon ? role.icon + ' ' : ''}${role.name}（${isolated ? '隔离上下文' : '共享上下文'}）`
        : '（无角色）';
      const agent = useWorkflowStore
        .getState()
        .agents.find((a) => a.id === agentId);
      const modelTag = modelOverride || agent?.model || '—';
      const lines = [
        `【离线模拟 · 角色链路回显】`,
        `角色：${roleTag}`,
        `智能体：${agent ? agent.name : '（未绑定）'}`,
        `模型：${modelTag}`,
        `上下文：${isolated ? 'isolated（独立，不污染共享）' : 'shared（共用全局）'}`,
        ``,
        `— 系统提示词 —`,
        system || '（无）',
        ``,
        `— 用户输入 —`,
        prompt,
        ``,
        `— 模拟回复 —`,
        `[本节点在模拟模式下不调用真实 LLM，以上为角色链路装配结果。关闭"离线模拟模式"并配置可用智能体后，此处将替换为模型实际输出。]`,
      ];
      // 模拟流式逐段回显
      let acc = '';
      for (const seg of lines) {
        acc += (acc ? '\n' : '') + seg;
        ctx.setPartial('text', acc);
        await new Promise((r) => setTimeout(r, 20));
      }
      ctx.logger.info(
        `离线模拟完成 角色=${role?.name ?? '无'}${isolated ? ' 隔离' : ''} prompt ${prompt.length} 字`,
      );
      return { text: acc };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定智能体，请在右侧面板选择（或开启离线模拟模式）');
    const messages = [];
    if (system) messages.push({ role: 'system' as const, content: system });
    messages.push({ role: 'user' as const, content: prompt });

    ctx.logger.info(
      `智能体请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''}${isolated ? ' 上下文隔离' : ''} prompt ${prompt.length} 字`,
    );

    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages,
      (delta) => {
        acc += delta;
        ctx.setPartial('text', acc);
      },
      modelOverride || undefined,
    );
    return { text };
  },
};

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

const httpRequest: NodeDefinition = {
  typeId: 'tool.http',
  name: 'HTTP 请求',
  category: '工具',
  description: '发起 HTTP 请求，URL 支持 {{url}} 端口注入',
  inputs: [{ id: 'url', label: 'URL(可选)', type: 'text' }],
  outputs: [{ id: 'body', label: '响应体', type: 'text' }],
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
  inputs: [{ id: 'value', label: '数据', type: 'any' }],
  outputs: [],
  params: [],
  async execute(inputs) {
    return { value: inputs.value };
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

const exprNode: NodeDefinition = {
  typeId: 'tool.expr',
  name: '表达式',
  category: '工具',
  description:
    '计算一个安全表达式，可引用输入端口 a/b、全局变量，输出 result。支持 + - * / % 比较 逻辑 三元 及 len/upper/lower/split/join/contains 等函数',
  inputs: [{ id: 'a', label: 'a', type: 'any' }, { id: 'b', label: 'b', type: 'any' }],
  outputs: [{ id: 'result', label: '结果', type: 'any' }],
  params: [
    {
      key: 'expression',
      label: '表达式',
      type: 'textarea',
      default: '',
      placeholder: '例如：a + b * 2，或 len(a)',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    if (!expr) return { result: undefined };
    const scope = { ...ctx.vars, ...inputs };
    const result = evalExpr(expr, scope);
    return { result };
  },
};

const ifNode: NodeDefinition = {
  typeId: 'flow.if',
  name: '条件分支',
  category: '流程',
  description:
    '根据条件表达式求值结果，只走 true / false 其中一条分支。下游若只连到未激活的分支则被跳过（不执行）。表达式可引用输入端口与全局变量，结果按「真值」判断（非空、非零、非空字符串、非空数组）。',
  inputs: [{ id: 'cond', label: '条件', type: 'any' }],
  outputs: [
    { id: 'true', label: '真', type: 'any' },
    { id: 'false', label: '假', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '条件表达式（可选，留空则直接用输入端口「条件」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：cond > 3，或 len(a) > 0',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    let value: unknown;
    if (expr) {
      const result = evalExpr(expr, { ...ctx.vars, ...inputs });
      value = result;
    } else {
      value = inputs.cond;
    }
    const truthy = isTruthy(value);
    // 声明激活分支：仅 true 或仅 false 端口生效，另一分支的下游被剪枝
    ctx.setBranches?.(truthy ? ['true'] : ['false']);
    return { result: truthy, taken: truthy ? 'true' : 'false' };
  },
};

const mergeNode: NodeDefinition = {
  typeId: 'flow.merge',
  name: '聚合',
  category: '流程',
  description:
    '将多路上游输入汇聚为一个数组输出，用于把并行或分支的结果重新汇合。未接入的端口忽略；另输出 first（第一个非空输入）便于直接取用单值。',
  inputs: [
    { id: 'a', label: '输入 A', type: 'any' },
    { id: 'b', label: '输入 B', type: 'any' },
    { id: 'c', label: '输入 C', type: 'any' },
  ],
  outputs: [
    { id: 'items', label: '数组', type: 'list' },
    { id: 'first', label: '首个', type: 'any' },
  ],
  params: [],
  async execute(inputs) {
    const present = [inputs.a, inputs.b, inputs.c].filter(
      (v) => v !== undefined && v !== null && v !== '',
    );
    return { items: present, first: present[0] ?? null };
  },
};

const delayNode: NodeDefinition = {
  typeId: 'flow.delay',
  name: '延迟',
  category: '流程',
  description:
    '等待指定毫秒后透传输入值，用于限速、节流或在分支流程中插入人工观察窗口。受全局中止信号控制，运行中可手动停止。',
  inputs: [{ id: 'value', label: '数据', type: 'any' }],
  outputs: [{ id: 'value', label: '数据', type: 'any' }],
  params: [
    {
      key: 'ms',
      label: '延迟（毫秒）',
      type: 'number',
      default: 1000,
      placeholder: '如 1000 表示等待 1 秒',
    },
  ],
  async execute(inputs, params, ctx) {
    const ms = Math.max(0, Number(params.ms ?? 0) || 0);
    if (ms > 0) {
      ctx.logger.info(`延迟 ${ms}ms`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('已中止'));
          },
          { once: true },
        );
      });
    }
    return { value: inputs.value };
  },
};

const switchNode: NodeDefinition = {
  typeId: 'flow.switch',
  name: '多路路由',
  category: '流程',
  description:
    '根据「匹配键」将流程路由到 c1~c4 中第一个匹配的分支，无匹配时走 _default 分支。未命中的分支下游被剪枝（不执行）。匹配键可由表达式计算（引用输入与全局变量），或留空直接用输入端口「键」。',
  inputs: [
    { id: 'key', label: '键(可选)', type: 'any' },
  ],
  outputs: [
    { id: 'c1', label: '分支1', type: 'any' },
    { id: 'c2', label: '分支2', type: 'any' },
    { id: 'c3', label: '分支3', type: 'any' },
    { id: 'c4', label: '分支4', type: 'any' },
    { id: '_default', label: '默认', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '匹配键表达式（可选，留空则用输入端口「键」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：key，或 input.category',
    },
    { key: 'm1', label: '分支1 匹配值', type: 'text', default: '' },
    { key: 'm2', label: '分支2 匹配值', type: 'text', default: '' },
    { key: 'm3', label: '分支3 匹配值', type: 'text', default: '' },
    { key: 'm4', label: '分支4 匹配值', type: 'text', default: '' },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    const keyVal = expr
      ? String(evalExpr(expr, { ...ctx.vars, ...inputs }))
      : String(inputs.key ?? '');
    const matches: Array<[string, string]> = [
      ['c1', String(params.m1 ?? '')],
      ['c2', String(params.m2 ?? '')],
      ['c3', String(params.m3 ?? '')],
      ['c4', String(params.m4 ?? '')],
    ];
    let taken = '_default';
    for (const [handle, want] of matches) {
      if (want !== '' && keyVal === want) {
        taken = handle;
        break;
      }
    }
    ctx.logger.info(`路由：键=${keyVal} → ${taken}`);
    ctx.setBranches?.([taken]);
    return {
      c1: inputs.key,
      c2: inputs.key,
      c3: inputs.key,
      c4: inputs.key,
      _default: inputs.key,
    };
  },
};

/** 真值判断：非空、非零、非空字符串/数组/对象 */
function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '' && v !== 'false' && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return Boolean(v);
}

export const builtinDefs: NodeDefinition[] = [
  textInput,
  agentChat,
  template,
  httpRequest,
  preview,
  listNode,
  mapNode,
  joinNode,
  exprNode,
  ifNode,
  mergeNode,
  delayNode,
  switchNode,
];

export function registerBuiltins(): void {
  useRegistryStore.getState().register(builtinDefs);
}
