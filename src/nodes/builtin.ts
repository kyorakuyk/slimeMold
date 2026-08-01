import type { NodeDefinition, AssetMeta, ContentPart, ChatMessage, TaskItem } from '../types';
import { httpFetch, isTauri } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { evalExpr } from '../engine/expr';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { findRole, resolveRoleSystem } from '../agents/agentManager';

/** 根据文件名推断资产类型，用于左侧「资产」面板的预览 */
function inferAssetKind(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'go', 'rs', 'cpp', 'c', 'sh'].includes(ext))
    return 'code';
  if (ext === 'json') return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['md', 'txt', 'log'].includes(ext)) return 'text';
  return 'text';
}

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
  category: 'AI',
  description:
    '调用绑定的智能体（多协议 LLM）处理输入文本。可绑定角色库中的角色快速获得职业提示词，并支持节点级模型覆写与上下文隔离。',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'image', label: '图片', type: 'image' },
  ],
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
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system' as const, content: system });

    // 多模态：若接入了图片（data URL 或 https 链接），构造图生文 user 消息
    const image = inputs.image != null ? String(inputs.image) : '';
    if (image) {
      const parts: ContentPart[] = [{ type: 'text', text: prompt || '请描述这张图片' }];
      const isDataUrl = image.startsWith('data:');
      const mediaType = isDataUrl
        ? image.slice(5, image.indexOf(';')) || 'image/png'
        : undefined;
      parts.push({ type: 'image', url: image, mediaType });
      messages.push({ role: 'user' as const, content: parts });
    } else {
      messages.push({ role: 'user' as const, content: prompt });
    }

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

/** 图片源：输入图片 URL 或 data URL，输出 image 端口，供图生文（如 agent.chat 的「图片」输入）使用。
 * 对应 ComfyUI 的 Load Image 节点，是图像管线的起点。 */
const imageLoad: NodeDefinition = {
  typeId: 'image.load',
  name: '图片',
  category: '输入',
  description: '加载一张图片（URL 或 data URL），输出 image 端口，可接入多模态智能体节点',
  params: [],
  inputs: [{ id: 'url', label: '图片 URL', type: 'text' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (_ctx, inputs) => {
    const url = inputs.url != null ? String(inputs.url).trim() : '';
    if (!url) throw new Error('请填写图片 URL 或 data URL');
    return { image: url };
  },
};

/** 图片导入：从资产库下拉选图，或手动填文件路径/URL，输出 image 端口。
 * 对应 ComfyUI 的 Load Image（但支持直接绑定已上传的资产）。 */
const imageImport: NodeDefinition = {
  typeId: 'image.import',
  name: '图片导入',
  category: '输入',
  description: '从资产库选择已上传的图片，或点气泡从本机文件资源管理器选图，输出 image 端口',
  params: [{ key: 'asset', label: '选择图片', type: 'asset' }],
  inputs: [],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (_inputs, params, ctx) => {
    const raw = (params.asset != null ? String(params.asset) : '') as string;
    // 桌面端从文件资源管理器选的本地系统路径
    if (raw.startsWith('path:')) {
      const p = raw.slice(5).trim();
      if (!p) throw new Error('未选择图片文件');
      return { image: p };
    }
    // 浏览器预览环境选的本地文件，已读为 data URL
    if (raw.startsWith('file:')) {
      const dataUrl = raw.slice(5);
      if (!dataUrl) throw new Error('未选择图片文件');
      return { image: dataUrl };
    }
    if (!raw) throw new Error('请在右侧下拉选择图片资产，或点 📂 从本机选图');
    const asset = ctx.assets.find((a) => a.id === raw);
    if (!asset) throw new Error('找不到对应图片资产（可能已被删除）');
    if (!asset.content) throw new Error('该资产无图片内容（请确认是图片资产）');
    return { image: asset.content }; // data URL
  },
};

/** 图片预览：输入 image 端口，把图片直接作为输出，在节点卡片上缩略图预览。 */
const imagePreview: NodeDefinition = {
  typeId: 'image.preview',
  name: '图片预览',
  category: '预览',
  description: '预览上游传来的图片（image 端口），在节点卡片上显示缩略图',
  params: [],
  inputs: [{ id: 'image', label: '图片', type: 'image' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (inputs) => {
    const img = inputs.image != null ? String(inputs.image) : '';
    if (!img) throw new Error('未接入图片');
    return { image: img };
  },
};

/** 图片保存：把上游 image 端口的图片写入资产库，供「资产」面板查看与导出。 */
const imageSave: NodeDefinition = {
  typeId: 'image.save',
  name: '图片保存',
  category: '资产',
  description: '把上游传来的图片（image 端口）保存到当前工作流资产库',
  params: [{ key: 'name', label: '资产名', type: 'text', default: 'image', placeholder: '如 cat.png' }],
  inputs: [{ id: 'image', label: '图片', type: 'image' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (inputs, params, ctx) => {
    const img = inputs.image != null ? String(inputs.image) : '';
    if (!img) throw new Error('未接入图片');
    const name = (params.name ? String(params.name) : 'image') || 'image';
    const ext = img.startsWith('data:')
      ? img.slice(5, img.indexOf(';')).split('/')[1] || 'png'
      : name.includes('.') ? '' : 'png';
    const finalName = ext && !name.includes('.') ? `${name}.${ext}` : name;
    ctx.addAsset({
      id: `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: finalName,
      path: null,
      kind: 'image',
      content: img,
      createdAt: new Date().toISOString(),
      nodeId: '',
      inWorkspace: false,
    });
    return { image: img };
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

/** 写文件节点：把输入内容写入工作区（或工作流内部目录），并登记为资产 */
export const nodeWriteFile: NodeDefinition = {
  typeId: 'tool.writeFile',
  name: '写文件',
  category: '工具',
  description:
    '将输入内容写入工作区文件夹（创建工作流时指定）或工作流内部目录，并在左侧「资产」面板生成预览。浏览器环境不落盘，仅登记预览。',
  inputs: [
    { id: 'content', label: '内容', type: 'text' },
    { id: 'filename', label: '文件名(可选)', type: 'text' },
  ],
  outputs: [{ id: 'path', label: '文件路径', type: 'text' }],
  params: [
    {
      key: 'filename',
      label: '文件名',
      type: 'text',
      default: 'output.txt',
      placeholder: 'hello_world.py',
    },
    {
      key: 'overwrite',
      label: '覆盖已存在文件',
      type: 'select',
      default: 'true',
      options: [
        { label: '覆盖', value: 'true' },
        { label: '不覆盖(重命名)', value: 'false' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const content = String(inputs.content ?? '');
    if (!content) throw new Error('输入内容为空，无法写文件');
    const filename = String(inputs.filename ?? params.filename ?? 'output.txt').trim();
    if (!filename) throw new Error('文件名为空');

    const wfId = useWorkflowStore.getState().activeWfId;
    const wf = useWorkflowStore.getState().workflows[wfId];
    const workspaceDir = wf?.workspaceDir ?? null;

    let absPath: string | null = null;
    let inWorkspace = false;

    if (isTauri) {
      const fs = await import('@tauri-apps/plugin-fs');
      const pathMod = await import('@tauri-apps/api/path');
      const baseDir = workspaceDir
        ? workspaceDir
        : `${await pathMod.appDataDir()}/slime-mold/${wfId}`;
      inWorkspace = !!workspaceDir;
      // 工作流内部目录需先确保存在
      if (!workspaceDir) {
        await fs.mkdir(baseDir, { recursive: true });
      }

      // 处理重名：不覆盖时追加 _1 _2 …
      let finalName = filename;
      if (params.overwrite !== 'true') {
        const exists = await fs.exists(`${baseDir}/${finalName}`);
        if (exists) {
          const dot = finalName.lastIndexOf('.');
          const stem = dot > 0 ? finalName.slice(0, dot) : finalName;
          const ext = dot > 0 ? finalName.slice(dot) : '';
          let i = 1;
          while (await fs.exists(`${baseDir}/${stem}_${i}${ext}`)) i++;
          finalName = `${stem}_${i}${ext}`;
        }
      }
      absPath = `${baseDir}/${finalName}`;
      await fs.writeTextFile(absPath, content);
      ctx.logger.info(`已写入文件：${absPath}`);
    } else {
      // 浏览器环境无法落盘，仅登记资产预览
      ctx.logger.info('浏览器环境不支持写文件，仅生成资产预览（未落盘）');
    }

    const meta: AssetMeta = {
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: filename,
      path: absPath,
      kind: inferAssetKind(filename),
      content,
      createdAt: new Date().toISOString(),
      inWorkspace,
    };
    useWorkflowStore.getState().addAsset(meta);

    return { path: absPath ?? `[资产预览] ${filename}` };
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

/**
 * 子图引用：把一组打包好的节点当作一个整体放到画布上。
 *
 * 它的端口是动态的——由所引用子图的 inputs/outputs 决定（见 engine/subgraph.ts 的 resolvePorts），
 * 所以这里 inputs/outputs 留空。运行前 executor 会调 flattenSubgraphs() 把它替换成内部节点，
 * 因此 execute 正常情况下不会被调用；保留实现只是为了兜底报错。
 */
const subgraphRef: NodeDefinition = {
  typeId: SUBGRAPH_REF_TYPE,
  name: '子图',
  category: '流程',
  description: '引用一个打包好的节点组合，可在多处复用；双击可进入编辑',
  params: [],
  inputs: [],
  outputs: [],
  execute: async () => {
    throw new Error('子图节点应在运行前被展开，请检查该子图的定义是否存在');
  },
};

// Community 友好分类顺序：输入 → 文本 → AI → 流程 → 工具 → 输出（普通用户语义）
export const CATEGORY_ORDER = ['输入', '文本', 'AI', '流程', '工具', '输出', '审计', '派发', '协调'] as const;

/**
 * 成本审计节点（Auditor / 书记员骨架）：
 * 运行结束时输出本次全流程的 token 用量与耗时汇总（JSON 文本）。
 * 不消费数据流——它通过 ExecContext.costLog 读取引擎累积的成本账本，
 * 因此放在工作流任何位置都会上报全链路成本；多个 Auditor 节点互不影响。
 */
export const nodeAuditor: NodeDefinition = {
  typeId: 'auditor.bookkeeper',
  name: '成本审计',
  category: '审计',
  description:
    '汇总本次运行所有 LLM 调用的 token 用量与耗时，输出成本报告（JSON）。不消费数据流，仅读取引擎成本账本。',
  inputs: [],
  outputs: [
    { id: 'report', label: '成本报告', type: 'text' },
    { id: 'totalTokens', label: '总 Token', type: 'number' },
    { id: 'totalDurationMs', label: '总耗时(ms)', type: 'number' },
  ],
  params: [
    {
      key: 'includeRecords',
      label: '包含逐条明细',
      type: 'select',
      default: 'on',
      options: [
        { value: 'on', label: '包含（完整账本）' },
        { value: 'off', label: '仅汇总（按模型归类）' },
      ],
    },
  ],
  async execute(_inputs, params, ctx) {
    const log = ctx.costLog ?? [];
    const includeRecords = params.includeRecords !== 'off';
    const byModel: Record<string, { promptTokens: number; completionTokens: number; calls: number }> = {};
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalDuration = 0;
    for (const r of log) {
      totalDuration += r.durationMs;
      if (!r.usage) continue;
      totalPrompt += r.usage.promptTokens ?? 0;
      totalCompletion += r.usage.completionTokens ?? 0;
      const m = (byModel[r.model] ??= { promptTokens: 0, completionTokens: 0, calls: 0 });
      m.promptTokens += r.usage.promptTokens ?? 0;
      m.completionTokens += r.usage.completionTokens ?? 0;
      m.calls += 1;
    }
    const report = {
      summary: {
        totalPromptTokens: totalPrompt,
        totalCompletionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
        totalDurationMs: totalDuration,
        llmCalls: log.length,
      },
      byModel: includeRecords ? byModel : undefined,
      records: includeRecords ? log : undefined,
    };
    return {
      report: JSON.stringify(report, null, 2),
      totalTokens: totalPrompt + totalCompletion,
      totalDurationMs: totalDuration,
    };
  },
};

/**
 * 任务派发节点（Dispatcher / TaskSplitter）：
 * 接收一个任务列表（每个元素为 TaskItem：{label, scope?, payload?}），
 * 1:n 扇出到 t1~t4 固定端口 + _rest；下游经「task」语义连线并行施工。
 * 框架层仅做数据扇出与 scope 标注，真正并行由执行引擎的拓扑并行调度完成。
 */
export const nodeDispatch: NodeDefinition = {
  typeId: 'dispatch.split',
  name: '任务派发',
  category: '派发',
  description:
    '将任务列表（TaskItem[]）扇出到多条任务连线并行派发。每个输出端口携带一个任务（含 scope 影响域声明）。未分配完的余数走「其余」端口。配合「task」语义连线（橙色）使用。',
  inputs: [{ id: 'tasks', label: '任务列表', type: 'list' }],
  outputs: [
    { id: 'task1', label: '任务1', type: 'any', flow: 'task' },
    { id: 'task2', label: '任务2', type: 'any', flow: 'task' },
    { id: 'task3', label: '任务3', type: 'any', flow: 'task' },
    { id: 'task4', label: '任务4', type: 'any', flow: 'task' },
    { id: 'rest', label: '其余', type: 'list', flow: 'task' },
  ],
  params: [
    {
      key: 'label1',
      label: '任务1 标签(可选)',
      type: 'text',
      default: '',
      placeholder: '覆盖原任务 label',
    },
    { key: 'label2', label: '任务2 标签(可选)', type: 'text', default: '' },
    { key: 'label3', label: '任务3 标签(可选)', type: 'text', default: '' },
    { key: 'label4', label: '任务4 标签(可选)', type: 'text', default: '' },
  ],
  async execute(inputs, params) {
    const raw = Array.isArray(inputs.tasks) ? inputs.tasks : [];
    const tasks: TaskItem[] = raw.map((t, i) => {
      if (typeof t === 'object' && t !== null && 'payload' in t) {
        return { ...(t as TaskItem), index: i };
      }
      // 允许传入纯字符串/文本，自动包装为 TaskItem
      return { label: typeof t === 'string' ? t : `任务${i + 1}`, payload: t, index: i };
    });
    const labels = [params.label1, params.label2, params.label3, params.label4].map((s) => String(s ?? ''));
    const pick = (i: number, fallback: TaskItem) => {
      const t = { ...fallback };
      if (labels[i]) t.label = labels[i];
      return t;
    };
    const out: Record<string, unknown> = {};
    out.task1 = tasks[0] ? pick(0, tasks[0]) : undefined;
    out.task2 = tasks[1] ? pick(1, tasks[1]) : undefined;
    out.task3 = tasks[2] ? pick(2, tasks[2]) : undefined;
    out.task4 = tasks[3] ? pick(3, tasks[3]) : undefined;
    out.rest = tasks.slice(4);
    return out;
  },
};

/**
 * 冲突协调者（Conflict Resolver / Merge Coordinator）：
 * 接收来自多条并行任务线的输出（每个输出应携带 scope 影响域声明），
 * 检测任意两个任务是否涉及同一文件/接口/抽象类（scope 交集）。
 * - 有冲突：走 `conflicts` 端口输出冲突清单（供人工/仲裁节点处理）
 * - 无冲突：走 `merged` 端口输出汇总的 scope 与结果
 * 框架层实现交并检测算法；真实「串行化重排」留给后续执行引擎增强。
 */
export const nodeResolver: NodeDefinition = {
  typeId: 'coord.resolver',
  name: '冲突协调者',
  category: '协调',
  description:
    '汇聚多路并行任务的输出，检测 scope（影响域）交集冲突。无冲突走「已合并」，有冲突走「冲突」端口输出冲突清单。每个上游任务输出建议携带 scope 字段（string[]）。',
  inputs: [
    { id: 'in1', label: '任务线1', type: 'any' },
    { id: 'in2', label: '任务线2', type: 'any' },
    { id: 'in3', label: '任务线3', type: 'any' },
    { id: 'in4', label: '任务线4', type: 'any' },
  ],
  outputs: [
    { id: 'merged', label: '已合并', type: 'list' },
    { id: 'conflicts', label: '冲突', type: 'list' },
  ],
  params: [
    {
      key: 'mode',
      label: '冲突处理方式',
      type: 'select',
      default: 'report',
      options: [
        { value: 'report', label: '仅报告（输出冲突清单，不阻断）' },
        { value: 'block', label: '阻断（有冲突则报错，下游不执行）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const present = [inputs.in1, inputs.in2, inputs.in3, inputs.in4].filter((v) => v != null);
    // 从每个上游输出中提取 scope（兼容 TaskItem 或 {scope:[...]} 结构）
    const entries = present.map((v, i) => {
      const scope = (typeof v === 'object' && v !== null && Array.isArray((v as any).scope))
        ? ((v as any).scope as string[])
        : [];
      const label = (typeof v === 'object' && v !== null && typeof (v as any).label === 'string')
        ? (v as any).label
        : `任务线${i + 1}`;
      return { label, scope, value: v };
    });

    // 两两检测 scope 交集
    const conflicts: Array<{ a: string; b: string; overlap: string[] }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const overlap = entries[i].scope.filter((s) => entries[j].scope.includes(s));
        if (overlap.length > 0) {
          conflicts.push({ a: entries[i].label, b: entries[j].label, overlap });
        }
      }
    }

    if (conflicts.length > 0) {
      ctx.logger.error(`检测到 ${conflicts.length} 处任务冲突：${conflicts.map((c) => `${c.a}↔${c.b}`).join(', ')}`);
      if (params.mode === 'block') {
        throw new Error(
          `冲突协调者阻断执行：\n${conflicts
            .map((c) => `- ${c.a} 与 ${c.b} 争用 ${c.overlap.join(', ')}`)
            .join('\n')}`,
        );
      }
      return { merged: [], conflicts };
    }
    return { merged: present, conflicts: [] };
  },
};

export const builtinDefs: NodeDefinition[] = [
  textInput,
  template,
  agentChat,
  subgraphRef,
  imageLoad,
  imageImport,
  imagePreview,
  imageSave,
  listNode,
  mapNode,
  joinNode,
  ifNode,
  mergeNode,
  delayNode,
  switchNode,
  exprNode,
  httpRequest,
  preview,
  textOutput,
  nodeAuditor,
  nodeDispatch,
  nodeResolver,
];

export function registerBuiltins(): void {
  useRegistryStore.getState().register(builtinDefs);
}
