import type { NodeDefinition, AssetMeta, ContentPart, ChatMessage, TaskItem, ModuleItem, ExecContext, FilePatch, MergeResult, CouncilVerdict } from '../types';
import { createNodeDef } from '../types';
import { httpFetch, isTauri } from '../platform/env';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { evalExpr } from '../engine/expr';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { findRole, resolveRoleSystem } from '../agents/agentManager';
import { creativeNodes } from './creative';
import { getArtifact, publishArtifactFromNode, type ArtifactKind } from '../engine/pipeline';
import { buildConstructionWorkflow, buildOpsWorkflow } from '../engine/builder';
import { toolRegistry } from '../agents/toolRegistry';
import { builtinTools } from './builtinTools';

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

/**
 * 自动推断文件名：让上游全能 worker 自行决定文件叫什么。
 * 1) 从 hint（上游任务文本，如「帮我生成一个 helloworld.py 文件」）提取显式文件名；
 * 2) 从内容首行/代码块语言推断扩展名；
 * 3) 兜底 output.txt。
 */
function inferFilename(opts: { hint: string; content: string }): string {
  const { hint, content } = opts;

  // 1) 从命名提示中提取 *.ext 形态的文件名（支持带路径、带引号）
  if (hint) {
    const m = hint.match(/[`'"\s]([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,10})[`'"\s]/)
      ?? hint.match(/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,10})/);
    if (m) {
      const name = m[1].split(/[\\/]/).pop()!; // 去掉可能的目录前缀
      if (name.includes('.')) return name;
    }
  }

  // 2) 从内容推断扩展名：先看首行 ```lang 围栏
  const fenceLang = content.match(/^\s*```([A-Za-z0-9+#-]+)/);
  let ext = fenceLang ? langToExt(fenceLang[1]) : '';
  if (!ext) {
    const head = content.slice(0, 400).toLowerCase();
    if (/^\s*(<!doctype html|<\?xml|<html)/.test(content)) ext = 'html';
    else if (/def\s+\w+\s*\(|import\s+(os|sys|re|json)|print\(/.test(head)) ext = 'py';
    else if (/function\s+\w+|const\s+\w+\s*=|<script/.test(head)) ext = 'js';
    else if (/interface\s+\w+|:\s*string\s*=|export\s+type/.test(head)) ext = 'ts';
    else if (/{[\s\S]*}|^\[[\s\S]*\]$/.test(content.trim())) ext = 'json';
    else if (/select\s+[\w*]+\s+from|insert\s+into|create\s+table/i.test(head)) ext = 'sql';
    else if (/^#\s|^\*\s|-\s/.test(content)) ext = 'md';
    else if (/:\s*\w+\s*;|@media|background:|color:/.test(head)) ext = 'css';
  }

  // 3) 尝试从内容首行拿到有意义的命名
  const firstLine = content.split('\n')[0].replace(/^[#/*\s-]+/, '').trim();
  let stem = 'output';
  if (firstLine && firstLine.length <= 40 && /[A-Za-z0-9_\-]/.test(firstLine)) {
    stem = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9_\-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'output';
  }
  return `${stem}${ext ? '.' + ext : '.txt'}`;
}

/** 把代码语言标记映射到扩展名 */
function langToExt(lang: string): string {
  const map: Record<string, string> = {
    python: 'py', py: 'py', javascript: 'js', js: 'js', jsx: 'jsx',
    typescript: 'ts', ts: 'ts', tsx: 'tsx', java: 'java', go: 'go',
    rust: 'rs', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs',
    html: 'html', xml: 'xml', css: 'css', scss: 'scss', json: 'json',
    markdown: 'md', md: 'md', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
    yaml: 'yaml', yml: 'yml', toml: 'toml', php: 'php', ruby: 'rb', r: 'r',
    swift: 'swift', kotlin: 'kt', dart: 'dart', lua: 'lua',
  };
  return map[lang.toLowerCase()] ?? '';
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
  role: 'io',
  whenToUse: '作为工作流的起点，提供固定文本或提示词；需要动态文本时用「模板拼接」。',
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
  role: 'worker',
  whenToUse: '需要调用 LLM 生成文本/做推理时使用；配合角色库快速获得职业提示词，支持节点级模型覆写。',
  description:
    '调用绑定的智能体（多协议 LLM）处理输入文本。可绑定角色库中的角色快速获得职业提示词，并支持节点级模型覆写与上下文隔离。',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'image', label: '图片', type: 'image' },
  ],
  outputs: [
    { id: 'text', label: '回复', type: 'text' },
    { id: 'filename', label: '推断文件名', type: 'text' },
  ],
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
    {
      key: 'toolNames',
      label: '可用工具（按名引用 ToolRegistry）',
      type: 'text',
      default: '',
      placeholder: '逗号分隔，如 tool.writeFile,tool.http；留空则无工具',
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
      const filename = inferFilename({ hint: prompt, content: acc });
      return { text: acc, filename };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定智能体，请在右侧面板选择（或开启离线模拟模式）');
    const agent = useWorkflowStore
      .getState()
      .agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`找不到智能体 ${agentId}（可能已被删除）`);

    // 多模态：若接入了图片（data URL 或 https 链接），构造图生文 user 消息
    const image = inputs.image != null ? String(inputs.image) : '';
    const userContent: string | ContentPart[] = image
      ? (() => {
          const parts: ContentPart[] = [{ type: 'text', text: prompt || '请描述这张图片' }];
          const isDataUrl = image.startsWith('data:');
          const mediaType = isDataUrl
            ? image.slice(5, image.indexOf(';')) || 'image/png'
            : undefined;
          parts.push({ type: 'image', url: image, mediaType });
          return parts;
        })()
      : prompt;

    // 解析工具名列表（按名引用 ToolRegistry）
    const toolNames = String(params.toolNames ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    ctx.logger.info(
      `智能体请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''}${isolated ? ' 上下文隔离' : ''} prompt ${prompt.length} 字${toolNames.length ? ` 工具=${toolNames.join(',')}` : ''}`,
    );

    try {
      // 统一走 ExecContext.llm（底层由 AgentHarness 承载 tool_call 多轮，复用 executor 限流/遥测）
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: userContent });
      const text = await ctx.llm(
        agentId,
        messages,
        (delta) => ctx.setPartial('text', delta),
        modelOverride || undefined,
        toolNames.length ? toolNames : undefined,
      );
      // 文件名由 Worker 本体自行推断：缺省时从提示词与内容猜测类型与文件名
      const filename = inferFilename({ hint: prompt, content: text });
      return { text, filename };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.error(`agent.chat 调用失败：${msg}`);
      return { text: `⚠️ 调用失败：${msg}`, filename: inferFilename({ hint: prompt, content: '' }) };
    }
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
  role: 'explorer',
  whenToUse: '需要抓取网页、调用 REST API 或拉取外部数据时；返回 body 可接入 LLM 处理。',
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
    { id: 'hint', label: '命名提示(可选)', type: 'text' },
  ],
  outputs: [
    { id: 'path', label: '文件路径', type: 'text' },
    { id: 'patch', label: '文件补丁(可选)', type: 'json' },
  ],
  params: [
    {
      key: 'filename',
      label: '文件名(留空=自动推断)',
      type: 'text',
      default: 'auto',
      placeholder: 'auto 或 hello_world.py',
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
    let content = String(inputs.content ?? '');
    if (!content) throw new Error('输入内容为空，无法写文件');

    // 自动剥离 markdown 代码围栏（LLM 常在代码外加 ```lang ... ``` 包裹）。
    // 若整体被单个围栏包裹，则取栅栏内纯文本，避免把解释文字写进文件。
    const fence = content.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
    if (fence) content = fence[1];

    // 文件名优先级：上游 filename 输入（Worker 本体推断）> 参数显式指定 > auto 时由 hint/content 推断
    let filename = String(inputs.filename ?? '').trim();
    if (!filename) filename = String(params.filename ?? 'auto').trim();
    if (!filename || filename.toLowerCase() === 'auto') {
      filename = inferFilename({
        hint: String(inputs.hint ?? ''),
        content,
      });
    }
    if (!filename) throw new Error('无法推断文件名，请在「文件名」参数中显式指定');

    const wfId = useWorkflowStore.getState().activeWfId;
    const wf = useWorkflowStore.getState().workflows[wfId];
    const workspaceDir = wf?.workspaceDir ?? null;

    let absPath: string | null = null;
    let inWorkspace = false;

    // 步骤 11 阶段 C：真沙箱模式——写文件落到本节点隔离目录，互不踩踏
    if (ctx.sandbox) {
      const sandboxPath = await ctx.sandbox.writeFile(filename, content);
      absPath = sandboxPath;
      inWorkspace = false;
      ctx.logger.info(
        ctx.sandbox.inBrowser
          ? `沙箱（内存态）已登记 ${filename}，待协调者汇总`
          : `已写入沙箱副本：${sandboxPath}（协调者 commit 后才进主工作区）`,
      );
    } else if (isTauri) {
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

    // 步骤 11 阶段 C：构造 FilePatch 供协调者内容级合并（阶段 A↔C 打通）。
    // path 用逻辑文件名（与 commitLanes 落盘文件名一致），before 为写前快照。
    let before: string | null = null;
    try {
      if (absPath) {
        // 沙箱/工作区现存的旧版本（首次写则读不到 → null）
        const fs = await import('@tauri-apps/plugin-fs');
        before = await fs.readTextFile(absPath);
      }
    } catch {
      before = null; // 新文件：无 before
    }
    const patch: FilePatch = {
      path: filename,
      before,
      after: content,
      // 沙箱隔离模式：各 Worker 独立副本，读快照标记为 object 来源（内容级合并可识别新建）
      readSnapshot: { source: 'object' },
    };

    return { path: absPath ?? `[资产预览] ${filename}`, patch };
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
  role: 'orchestrator',
  whenToUse: '根据条件表达式只走 true/false 一条分支；未激活分支的下游会被跳过（不执行）。',
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
export const CATEGORY_ORDER = ['输入', '文本', 'AI', '流程', '工具', '输出', '审计', '派发', '协调', 'worker'] as const;

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
  role: 'verifier',
  whenToUse: '运行结束后汇总全链路 token 用量与耗时，输出成本报告，用于性价比分析与自优化闭环。',
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
  role: 'orchestrator',
  whenToUse: '将任务列表扇出到多条 task 连线并行派发，配合「冲突协调者」做并发冲突检测。',
  description:
    '将任务列表（TaskItem[]）扇出到多条任务连线并行派发。每个输出端口携带一个任务（含 scope 影响域声明）。未分配完的余数走「其余」端口。配合「task」语义连线（橙色）使用。',
  inputs: [
    { id: 'tasks', label: '任务列表', type: 'list' },
    { id: 'rerun', label: '重派信号(控制流)', type: 'any', flow: 'control' },
  ],
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
  async execute(inputs, params, ctx) {
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
    const portTasks: { handle: string; task?: TaskItem }[] = [
      { handle: 'task1', task: tasks[0] },
      { handle: 'task2', task: tasks[1] },
      { handle: 'task3', task: tasks[2] },
      { handle: 'task4', task: tasks[3] },
    ];
    // 把每个任务端口声明的影响域(scope)写回对应的 task 连线，供下游「冲突协调者」读取
    for (const { handle, task } of portTasks) {
      if (task && ctx.writeOutEdgeScope) {
        ctx.writeOutEdgeScope(handle, Array.isArray(task.scope) ? task.scope : []);
      }
    }
    out.task1 = tasks[0] ? pick(0, tasks[0]) : undefined;
    out.task2 = tasks[1] ? pick(1, tasks[1]) : undefined;
    out.task3 = tasks[2] ? pick(2, tasks[2]) : undefined;
    out.task4 = tasks[3] ? pick(3, tasks[3]) : undefined;
    out.rest = tasks.slice(4);
    return out;
  },
};

/**
 * 规划/编排节点（Plan / Orchestrator）：
 * 把一句目标交给绑定的「规划模型」，产出计划书，并自动把计划切成任务清单（TaskItem[]），
 * 供下游「任务派发（dispatch.split）」1:n 扇出到并行施工线。
 *
 * 设计动机：让「一句目标 → 计划 → 任务派发」显式画成一条流水线（对齐多 Agent 编排的
 * Planner → 派发 分层），同时让规划模型可独立选择（性价比模型做规划，强模型做施工）。
 *
 * 输出：
 * - plan：markdown 计划书（供预览 / 存档）
 * - tasks：切分好的任务清单（TaskItem[]，直接接 dispatch.split.tasks）
 * - summary：一句话摘要（供下游判断/分支）
 *
 * 任务切分：提示模型以「```json 任务数组```」围栏输出结构化清单（{label, scope?, payload?}）；
 * 解析成功则作为 tasks，解析失败则降级为「把目标整体作为一个任务」。
 */
export const nodePlan: NodeDefinition = {
  typeId: 'dispatch.plan',
  name: '规划/编排',
  category: '派发',
  role: 'orchestrator',
  whenToUse: '把一句话目标交给规划模型，生成计划书并自动切分为任务清单，供下游「任务派发」并行施工。',
  description:
    '接收目标描述，调用绑定的规划模型生成计划书，并把计划自动切分为任务清单（TaskItem[]）。输出 plan（计划书）/ tasks（任务列表，可直接接「任务派发」）/ summary（一句话摘要）。',
  inputs: [{ id: 'goal', label: '目标', type: 'text' }],
  outputs: [
    { id: 'plan', label: '计划书', type: 'text' },
    { id: 'tasks', label: '任务清单', type: 'list' },
    { id: 'summary', label: '摘要', type: 'text' },
  ],
  params: [
    { key: 'agentId', label: '绑定规划智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 kimi / gpt-4o-mini；规划用性价比模型更省',
    },
    {
      key: 'format',
      label: '计划书格式',
      type: 'select',
      default: 'tasks',
      options: [
        { value: 'tasks', label: '任务清单（含步骤说明）' },
        { value: 'outline', label: '提纲（章节式）' },
        { value: 'free', label: '自由（交给模型）' },
      ],
    },
    {
      key: 'simulate',
      label: '离线模拟模式（不调 LLM，回显链路）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const goal = String(inputs.goal ?? '').trim();
    if (!goal) throw new Error('缺少目标输入（goal 端口未接入数据）');

    const agentId = String(params.agentId ?? '');
    const roleId = String(params.roleId ?? '');
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system = resolveRoleSystem(role, String(params.system ?? '')) ||
      '你是一名严谨的项目规划助手。请把用户目标拆解为清晰、可执行的计划，并输出任务清单。';
    const modelOverride = String(params.modelOverride ?? '').trim();
    const format = String(params.format ?? 'tasks');

    const buildPrompt = (): string => {
      const fmtHint =
        format === 'outline'
          ? '请以章节式提纲（大纲）组织计划，先总述再分节。'
          : format === 'free'
            ? '请自由组织计划书，结构清晰即可。'
            : '请把计划组织成可执行的步骤清单。';
      return `${fmtHint}

目标：
${goal}

请输出计划书，并在最后用如下围栏块给出结构化任务数组（每项：{label, scope?（影响的文件/模块列表）, payload?}），以便下游并行派发：
\`\`\`json
[{"label":"任务描述","scope":["文件/模块"],"payload":"可选附加内容"}]
\`\`\`
若确实无法切分，也请给出至少一项任务。`;
    };

    // —— 离线模拟模式：不调 LLM，按链路回显便于无模型验证 ——
    if (String(params.simulate ?? 'off') === 'on') {
      const agent = useWorkflowStore.getState().agents.find((a) => a.id === agentId);
      const modelTag = modelOverride || agent?.model || '—';
      const plan = `【离线模拟 · 规划链路回显】

— 目标 —
${goal}

— 计划书（模拟） —
1. 明确需求与边界。
2. 拆解为若干独立子任务（每项声明影响域 scope）。
3. 并行施工、冲突协调、质量校验。

— 任务清单（模拟） —
${JSON.stringify(
  [
    { label: '分析目标与约束', scope: ['docs'], payload: goal },
    { label: '设计实现方案', scope: ['src'], payload: goal },
    { label: '编码与自测', scope: ['src'], payload: goal },
  ],
  null,
  2,
)}

（本节点在模拟模式下不调用真实 LLM，以上为链路装配结果。配置可用智能体并关闭模拟后替换为模型实际输出。）`;
      const tasks: TaskItem[] = [
        { label: '分析目标与约束', scope: ['docs'], payload: goal, index: 0 },
        { label: '设计实现方案', scope: ['src'], payload: goal, index: 1 },
        { label: '编码与自测', scope: ['src'], payload: goal, index: 2 },
      ];
      ctx.logger.info(`规划(模拟)完成 智能体=${agent?.name ?? '未绑定'} 模型=${modelTag} 目标 ${goal.length} 字`);
      // 流式回显计划书
      let acc = '';
      for (const seg of plan) {
        acc += seg;
        ctx.setPartial('plan', acc);
        await new Promise((r) => setTimeout(r, 4));
      }
      return { plan, tasks, summary: goal.slice(0, 40) };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定规划智能体，请在右侧面板选择（或开启离线模拟模式）');
    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: buildPrompt() },
    ];

    ctx.logger.info(
      `规划请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''} 目标 ${goal.length} 字`,
    );
    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages,
      (delta) => {
        acc += delta;
        ctx.setPartial('plan', acc);
      },
      modelOverride || undefined,
    );

    // 解析任务清单：优先取围栏内的 json 数组
    const tasks = extractTasksFromPlan(text, goal);
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    const summary = (firstLine ? firstLine.replace(/^[#*\s-]+/, '').trim() : goal.slice(0, 40)).slice(0, 60);
    return { plan: text, tasks, summary };
  },
};

/**
 * 架构师节点（Architect / 技术设计者）：
 * 接收「目标 + 可选约束（现有代码/技术栈/边界）」，调用绑定的架构模型产出技术设计：
 * 模块划分、职责、影响域（scope）、依赖关系。输出与派发节点协议兼容的模块清单，
 * 可直接接入「任务派发」节点并行施工，构成 规划 → 架构 → 派发 流水线。
 *
 * 与 Planner 的区别：
 * - Planner 回答「做什么 / 拆成哪些任务」（产品-计划层）
 * - Architect 回答「怎么做 / 模块·接口·数据流如何设计」（技术设计层）
 *
 * 输出：
 * - design：架构设计书（markdown，供预览/存档）
 * - modules：模块清单（ModuleItem[]，含 scope/dependsOn，可直接接 dispatch.split）
 * - summary：一句话摘要（供下游判断/分支）
 *
 * 模块切分：提示模型以「```json 模块数组```」围栏输出结构化清单
 * （{name, responsibility?, scope?, dependsOn?, payload?}）；解析成功作为 modules，
 * 失败降级为「把目标整体作为一个模块」。
 */
export const nodeArchitect: NodeDefinition = {
  typeId: 'architect.design',
  name: '架构师',
  category: '派发',
  role: 'architect',
  whenToUse: '把目标（与现有约束）交给架构模型，产出模块划分与技术设计，输出模块清单供下游「任务派发」并行施工。',
  description:
    '接收目标与可选约束，调用绑定的架构模型产出技术设计书与模块清单（ModuleItem[]，含 scope 影响域与 dependsOn 依赖）。输出 design（设计书）/ modules（模块列表，可直接接「任务派发」）/ summary（一句话摘要）。',
  inputs: [
    { id: 'goal', label: '目标', type: 'text' },
    { id: 'constraints', label: '约束(可选)', type: 'text' },
  ],
  outputs: [
    { id: 'design', label: '设计书', type: 'text' },
    { id: 'modules', label: '模块清单', type: 'list' },
    { id: 'summary', label: '摘要', type: 'text' },
  ],
  params: [
    { key: 'agentId', label: '绑定架构智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 claude-opus / gpt-4o；架构用强模型更稳',
    },
    {
      key: 'format',
      label: '设计书格式',
      type: 'select',
      default: 'modules',
      options: [
        { value: 'modules', label: '模块清单（含职责/依赖）' },
        { value: 'diagram', label: '架构图式（分层/组件）' },
        { value: 'free', label: '自由（交给模型）' },
      ],
    },
    {
      key: 'simulate',
      label: '离线模拟模式（不调 LLM，回显链路）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
    {
      key: 'pipelineStage',
      label: 'Pipeline 阶段标识（跨工作流交付物落盘用）',
      type: 'text',
      default: 'design',
      placeholder: '如 design / plan；留空不发布 Artifact',
      tooltip: '将该节点产出的 design 交付物写入项目级黑板对应阶段，供 Builder/施工方工作流读取。',
    },
  ],
  async execute(inputs, params, ctx) {
    const goal = String(inputs.goal ?? '').trim();
    if (!goal) throw new Error('缺少目标输入（goal 端口未接入数据）');
    const constraints = String(inputs.constraints ?? '').trim();

    const agentId = String(params.agentId ?? '');
    const roleId = String(params.roleId ?? '');
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system =
      resolveRoleSystem(role, String(params.system ?? '')) ||
      '你是一名资深软件架构师。请基于用户目标（与可选约束）给出清晰、可落地的技术设计：模块划分、职责边界、影响域（涉及的文件/接口/抽象类）与依赖关系。';
    const modelOverride = String(params.modelOverride ?? '').trim();
    const format = String(params.format ?? 'modules');

    const buildPrompt = (): string => {
      const fmtHint =
        format === 'diagram'
          ? '请以分层/组件视图组织设计（可用文本图或缩进列表表达层级与依赖）。'
          : format === 'free'
            ? '请自由组织架构设计书，结构清晰即可。'
            : '请将设计组织为清晰的模块清单，每项说明职责与依赖。';
      const constraintHint = constraints
        ? `\n\n— 现有约束 / 上下文 —\n${constraints}\n（请在设计中考量上述约束，避免与之冲突。）`
        : '';
      return `${fmtHint}

— 目标 —
${goal}${constraintHint}

请输出架构设计书，并在最后用如下围栏块给出结构化模块数组（每项：{name, category, responsibility?, scope?（影响的文件/模块列表）, dependsOn?（依赖的其它模块名）, payload?}），以便下游 Builder 经「类别→智能体」路由表绑定 agent 并行施工：
\`\`\`json
[{"name":"模块名","category":"ui|logic|docs|infra|data","responsibility":"职责说明","scope":["文件/模块"],"dependsOn":["其它模块名"],"payload":"可选附加内容"}]
\`\`\`
category 必填，从 ui(前端/界面) / logic(核心逻辑/算法) / docs(文档/说明) / infra(构建/部署/配置) / data(数据/存储/接口契约) 中择一，无法归类可填 data。
若确实无法切分，也请给出至少一个模块。`;
    };

    // —— 离线模拟模式：不调 LLM，按链路回显便于无模型验证 ——
    if (String(params.simulate ?? 'off') === 'on') {
      const agent = useWorkflowStore.getState().agents.find((a) => a.id === agentId);
      const modelTag = modelOverride || agent?.model || '—';
      const design = `【离线模拟 · 架构链路回显】

— 目标 —
${goal}${constraints ? `\n— 约束 —\n${constraints}` : ''}

— 架构设计书（模拟） —
1. 划分核心模块，明确职责边界。
2. 声明每个模块的影响域（scope）与依赖（dependsOn）。
3. 并行施工、冲突协调、质量校验。

— 模块清单（模拟） —
${JSON.stringify(
  [
    { name: 'api', responsibility: '对外接口层', scope: ['src/api'], dependsOn: [], payload: goal },
    { name: 'core', responsibility: '核心业务逻辑', scope: ['src/core'], dependsOn: ['api'], payload: goal },
    { name: 'store', responsibility: '状态与持久化', scope: ['src/store'], dependsOn: ['core'], payload: goal },
  ],
  null,
  2,
)}`;
      const modules: ModuleItem[] = [
        { name: 'api', responsibility: '对外接口层', category: 'ui', scope: ['src/api'], dependsOn: [], payload: goal, index: 0 },
        { name: 'core', responsibility: '核心业务逻辑', category: 'logic', scope: ['src/core'], dependsOn: ['api'], payload: goal, index: 1 },
        { name: 'store', responsibility: '状态与持久化', category: 'data', scope: ['src/store'], dependsOn: ['core'], payload: goal, index: 2 },
      ];
      ctx.logger.info(`架构(模拟)完成 智能体=${agent?.name ?? '未绑定'} 模型=${modelTag} 目标 ${goal.length} 字`);
      let acc = '';
      for (const seg of design) {
        acc += seg;
        ctx.setPartial('design', acc);
        await new Promise((r) => setTimeout(r, 4));
      }
      publishDesignArtifact(params, { design, modules, summary: goal.slice(0, 40) });
      return { design, modules, summary: goal.slice(0, 40) };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定架构智能体，请在右侧面板选择（或开启离线模拟模式）');
    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: buildPrompt() },
    ];

    ctx.logger.info(
      `架构请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''} 目标 ${goal.length} 字`,
    );
    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages,
      (delta) => {
        acc += delta;
        ctx.setPartial('design', acc);
      },
      modelOverride || undefined,
    );

    const modules = extractModulesFromDesign(text, goal);
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    const summary = (firstLine ? firstLine.replace(/^[#*\s-]+/, '').trim() : goal.slice(0, 40)).slice(0, 60);
    const out = { design: text, modules, summary };
    publishDesignArtifact(params, out);
    return out;
  },
};

/** architect.design 执行完后，把 design 交付物写入项目级黑板（跨工作流协作）。stage 由节点参数 pipelineStage 决定（默认 'design'）。 */
function publishDesignArtifact(params: Record<string, unknown>, payload: { design: string; modules: ModuleItem[]; summary: string }): void {
  const stage = String(params.pipelineStage ?? '').trim();
  if (!stage) return; // 留空表示不参与跨工作流协作，不发布
  try {
    publishArtifactFromNode({ stage, kind: 'design', payload });
  } catch (e) {
    // 发布失败不应中断节点主流程（artifact 是旁路交付物）
    console.warn('[architect.design] 发布 design artifact 失败：', e);
  }
}

/** 从模块原始对象中规整出合法 ModuleCategory（非约定值降级为 'data'，但保留任意字符串以允许自定义类别）。 */
function normalizeCategory(raw: unknown): ModuleItem['category'] {
  const c = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!c) return 'data';
  return c; // 保留任意字符串（路由表键可自定义），仅做小写规整
}

/** 从模型架构设计文本中提取模块清单；解析失败降级为「整个目标作为一个模块」。 */
function extractModulesFromDesign(text: string, fallbackGoal: string): ModuleItem[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const m = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((t, i) => {
          const name = typeof t?.name === 'string' && t.name.trim() ? t.name : `模块${i + 1}`;
          const responsibility =
            typeof t?.responsibility === 'string' && t.responsibility.trim()
              ? t.responsibility
              : name;
          const scope = Array.isArray(t?.scope) ? t.scope.filter((s: unknown) => typeof s === 'string') : undefined;
          const dependsOn = Array.isArray(t?.dependsOn)
            ? t.dependsOn.filter((s: unknown) => typeof s === 'string')
            : undefined;
          return {
            name,
            responsibility,
            category: normalizeCategory(t?.category),
            scope: scope && scope.length > 0 ? scope : undefined,
            dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
            payload: t?.payload,
            index: i,
          };
        });
      }
    } catch {
      /* 落入降级分支 */
    }
  }
  return [{ name: fallbackGoal, responsibility: fallbackGoal, category: 'data', payload: fallbackGoal, index: 0 }];
}

/** 从模型计划文本中提取任务清单；解析失败降级为「整个目标作为一个任务」。 */
function extractTasksFromPlan(text: string, fallbackGoal: string): TaskItem[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const m = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((t, i) => {
          const label = typeof t?.label === 'string' && t.label.trim() ? t.label : `任务${i + 1}`;
          const scope = Array.isArray(t?.scope) ? t.scope.filter((s: unknown) => typeof s === 'string') : undefined;
          return { label, scope: scope && scope.length > 0 ? scope : undefined, payload: t?.payload, index: i };
        });
      }
    } catch {
      /* 落入降级分支 */
    }
  }
  return [{ label: fallbackGoal, payload: fallbackGoal, index: 0 }];
}

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
    '汇聚多路并行任务的输出，做逻辑冲突检查。支持两种输入：①对象自带 scope（TaskItem.scope）或连线 scope；②FilePatch（{path,before,after,readSnapshot}）内容级补丁。无逻辑冲突时「已合并」端口输出 MergeResult（按 path 汇总的补丁 + 需仲裁清单），建议下游接 Validator 校验后再落盘；有冲突时「冲突」端口输出清单，「建议串行顺序」给出按争用 scope 分组顺序。参数 mode=block 时冲突即阻断下游。',
  inputs: [
    { id: 'in1', label: '任务线1', type: 'any' },
    { id: 'in2', label: '任务线2', type: 'any' },
    { id: 'in3', label: '任务线3', type: 'any' },
    { id: 'in4', label: '任务线4', type: 'any' },
  ],
  outputs: [
    { id: 'merged', label: '已合并', type: 'json' },
    { id: 'conflicts', label: '冲突', type: 'list' },
    { id: 'serialOrder', label: '建议串行顺序', type: 'list' },
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
    {
      key: 'mergeMode',
      label: '合并策略',
      type: 'select',
      default: 'content',
      options: [
        { value: 'scope', label: '仅按 scope 字符串交集检测（旧逻辑）' },
        { value: 'content', label: '内容级 FilePatch 合并（推荐，带回滚快照识别）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const present = [inputs.in1, inputs.in2, inputs.in3, inputs.in4].filter((v) => v != null);

    // 步骤 11.1：scope 来源并存归一 + source 标记；步骤 11.6 方案②：readSnapshot 陈旧识别
    const collectScopes = (v: any): { scope: string[]; source: 'object' | 'edge' | 'both' | 'none' } => {
      const objScope = Array.isArray(v?.scope) ? (v.scope as string[]) : [];
      const edgeScope = Array.isArray(v?.edgeScope) ? (v.edgeScope as string[]) : [];
      if (objScope.length && edgeScope.length) return { scope: Array.from(new Set([...objScope, ...edgeScope])), source: 'both' };
      if (objScope.length) return { scope: objScope, source: 'object' };
      if (edgeScope.length) return { scope: edgeScope, source: 'edge' };
      return { scope: [], source: 'none' };
    };

    // 是否内容级合并模式：任一输入为 FilePatch / FilePatch[] 即启用
    const toPatches = (v: any): FilePatch[] => {
      if (Array.isArray(v)) return v.filter((p) => p && typeof p.path === 'string') as FilePatch[];
      if (v && typeof v.path === 'string') return [v as FilePatch];
      if (v && Array.isArray(v.patches)) return (v.patches as FilePatch[]).filter((p) => p && typeof p.path === 'string');
      // 允许 input.text 等以 JSON 字符串形式传递补丁（离线演示/外部注入场景）
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return toPatches(parsed);
        } catch {
          return [];
        }
      }
      return [];
    };
    const allPatches = present.flatMap(toPatches);
    const useContent = params.mergeMode === 'content' && allPatches.length > 0;

    if (useContent) {
      return resolveByContent(allPatches, present, params, ctx);
    }

    // ---- 旧逻辑：纯 scope 交集检测（作为 content 模式的 fallback） ----
    const entries = present.map((v, i) => {
      const { scope, source } = collectScopes(v);
      const vv = v as { label?: unknown; name?: unknown };
      const label =
        (vv.label && typeof vv.label === 'string') ? vv.label
        : (vv.name && typeof vv.name === 'string') ? vv.name
        : `任务线${i + 1}`;
      return { label, scope, source, value: v };
    });

    const conflicts: Array<{ a: string; b: string; overlap: string[] }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const overlap = entries[i].scope.filter((s) => entries[j].scope.includes(s));
        if (overlap.length > 0) conflicts.push({ a: entries[i].label, b: entries[j].label, overlap });
      }
    }

    const serialOrder: Array<{ scope: string[]; order: string[] }> = [];
    if (conflicts.length > 0) {
      const groups: Array<{ scope: string[]; members: Set<string> }> = [];
      for (const c of conflicts) {
        const hit = groups.find((g) => c.overlap.some((o) => g.scope.includes(o)));
        if (hit) {
          hit.scope = Array.from(new Set([...hit.scope, ...c.overlap]));
          hit.members.add(c.a); hit.members.add(c.b);
        } else {
          groups.push({ scope: [...c.overlap], members: new Set([c.a, c.b]) });
        }
      }
      for (const g of groups) {
        serialOrder.push({ scope: g.scope, order: entries.filter((e) => g.members.has(e.label)).map((e) => e.label) });
      }
    }

    if (conflicts.length > 0) {
      const detail = conflicts.map((c) => `- ${c.a} 与 ${c.b} 争用 ${c.overlap.join(', ')}`).join('\n');
      ctx.logger.error(`检测到 ${conflicts.length} 处任务冲突：${conflicts.map((c) => `${c.a}↔${c.b}`).join(', ')}`);
      if (params.mode === 'block') {
        const advise = serialOrder.length
          ? `\n建议串行化顺序：\n${serialOrder.map((g) => `  争用[${g.scope.join(', ')}]：${g.order.join(' → ')}`).join('\n')}`
          : '';
        throw new Error(`冲突协调者阻断执行：\n${detail}${advise}`);
      }
      return { merged: [], conflicts, serialOrder };
    }
    return { merged: present, conflicts: [], serialOrder: [] };
  },
};

/** 步骤 11.6 方案①②：内容级 FilePatch 合并 + readSnapshot 陈旧识别。
 * 同一 path 的多个补丁：
 * - 文本区间（lineRange）不重叠 ⇒ 直接合并进 patches；
 * - 区间重叠 / readSnapshot.hash 不一致（提示有人已动同一处）⇒ 归入 needsArbitration，交 council 节点。 */
async function resolveByContent(patches: FilePatch[], _origins: unknown[], params: Record<string, unknown>, ctx: ExecContext) {
  const byPath = new Map<string, FilePatch[]>();
  for (const p of patches) {
    const arr = byPath.get(p.path) ?? [];
    arr.push(p);
    byPath.set(p.path, arr);
  }

  const merged: FilePatch[] = [];
  const needsArbitration: Array<{ path: string; candidates: FilePatch[] }> = [];
  const sources: Array<'object' | 'edge' | 'both'> = [];

  for (const [path, candidates] of byPath) {
    if (candidates.length === 1) {
      merged.push(candidates[0]);
      const s = candidates[0].readSnapshot?.source;
      if (s) sources.push(s);
      continue;
    }
    // 多候选：检测区间重叠 + 快照陈旧
    const stale = candidates.some((c) => c.readSnapshot?.hash && candidates.some((o) => o !== c && o.readSnapshot?.hash && o.readSnapshot.hash !== c.readSnapshot?.hash));
    const overlapRange = candidates.some((c) => {
      const [cs, ce] = c.readSnapshot?.lineRange ?? [0, Infinity];
      return candidates.some((o) => {
        if (o === c) return false;
        const [os, oe] = o.readSnapshot?.lineRange ?? [0, Infinity];
        return cs <= oe && os <= ce; // 区间相交
      });
    });
    if (stale || overlapRange) {
      needsArbitration.push({ path, candidates });
      ctx.logger.error(`路径 ${path} 存在 ${candidates.length} 份冲突补丁（快照陈旧或行区间重叠），交 council 仲裁`);
    } else {
      // 区间不重叠：按顺序拼接（简单合并，真实语义合并留给 Validator / 下游 LLM）
      merged.push({ path, before: candidates[0].before, after: candidates.map((c) => c.after).join('\n') });
      const s = candidates[0].readSnapshot?.source;
      if (s) sources.push(s);
    }
  }

  const result: MergeResult = { patches: merged, needsArbitration, sources };
  const conflictCount = needsArbitration.length;
  if (conflictCount > 0) {
    ctx.logger.error(`内容级合并检测到 ${conflictCount} 个文件需仲裁：${needsArbitration.map((n) => n.path).join(', ')}`);
    if (params.mode === 'block') {
      throw new Error(`冲突协调者阻断：${conflictCount} 个文件存在逻辑冲突，需 council 仲裁后再继续`);
    }
    return { merged: result, conflicts: needsArbitration, serialOrder: [] };
  }
  // 无冲突：merged 输出 MergeResult（建议下游接 Validator 校验后落盘，对应步骤 11.6 方案①）
  ctx.logger.info(`内容级合并完成：合并 ${merged.length} 个补丁，无逻辑冲突（建议下游接 Validator 校验）`);

  // 步骤 11 阶段 C：真沙箱模式——把各 Worker 车道的沙箱副本汇总落盘到主工作区
  if (ctx.sandbox && ctx.sandboxLanes?.length) {
    const committed = await ctx.sandbox.commitLanes(ctx.sandboxLanes);
    if (committed.length) {
      ctx.logger.info(`沙箱汇总：已将 ${committed.length} 个 Worker 产物提交到主工作区：${committed.join(', ')}`);
    } else {
      ctx.logger.info('沙箱汇总：上游车道无沙箱产物（可能未使用写文件节点）');
    }
  }

  return { merged: result, conflicts: [], serialOrder: [] };
}

/**
 * 仲裁委员会（Council）：
 * 对应 OMO-slim 的 Council agent 范式（步骤 11.7.1）。接收冲突双方/多方观点，
 * - 并行层：用多个「议员」智能体（councillorAgentIds，逗号分隔）各自独立评估（对应 OMO councillors）；
 * - 合成层：用独立的「合成」智能体（synthesizerAgentId，应不同于议员）提炼为单一裁决（对应 OMO synthesizer）；
 * - 共识评级：unanimous / majority / split（对应 OMO Consensus Rating）；
 * - 容错：部分议员失败则用成功者合成（对应 executor 的 skipFailed 语义）。
 * 仅在 coord.resolver 判定冲突后（经其 conflicts 端口）触发，避免每条线都跑（控制成本，对应 11.7 教训）。
 */
export const nodeCouncil: NodeDefinition = {
  typeId: 'coord.council',
  name: '仲裁委员会',
  category: '协调',
  role: 'orchestrator',
  whenToUse: '当 coord.resolver 的「冲突」端口输出后，需要把双方观点交多模型仲裁并产出单一裁决时使用；其输出可经 control 边回流 dispatch.split 或更上游重派。',
  description:
    '多模型并行仲裁节点（对标 OMO-slim Council）。并行层用多个议员智能体独立评估争议，合成层用独立合成智能体提炼单一裁决 verdict，并给出共识评级（unanimous/majority/split）与部分失败标记。仅在冲突时触发。',
  inputs: [
    { id: 'dispute', label: '争议观点', type: 'any' },
    { id: 'context', label: '背景上下文', type: 'any' },
    { id: 'question', label: '仲裁问题', type: 'text' },
  ],
  outputs: [
    { id: 'verdict', label: '裁决', type: 'json' },
    { id: 'councillors', label: '议员意见', type: 'list' },
    { id: 'consensus', label: '共识评级', type: 'text' },
    { id: 'backflow', label: '回流裁决', type: 'json', flow: 'control' },
  ],
  params: [
    {
      key: 'councillorAgentIds',
      label: '议员智能体 IDs（逗号分隔，并行评估）',
      type: 'text',
      default: '',
      placeholder: 'agentA,agentB,agentC',
    },
    {
      key: 'synthesizerAgentId',
      label: '合成智能体 ID（应不同于议员）',
      type: 'text',
      default: '',
      placeholder: 'agentJudge',
    },
    {
      key: 'simulate',
      label: '离线模拟（无模型时回显）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用 LLM）' },
        { value: 'on', label: '开启（回显角色链路，不调 LLM）' },
      ],
    },
    {
      key: 'pipelineStage',
      label: 'Pipeline 阶段标识（回流裁决落盘用）',
      type: 'text',
      default: 'design',
      placeholder: '如 design；留空不发布回流 Artifact',
      tooltip: '把裁决写入项目级黑板对应阶段，经 backflow 控制流端口回流上游重派。',
    },
  ],
  async execute(inputs, params, ctx) {
    const dispute = inputs.dispute;
    const context = inputs.context != null ? String(inputs.context) : '';
    const question = String(inputs.question ?? '请就上述争议给出裁决：应采用哪一方案，或如何融合？');

    const councillorIds = String(params.councillorAgentIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const synthId = String(params.synthesizerAgentId ?? '').trim();
    const simulate = String(params.simulate ?? 'off') === 'on';

    // 离线模拟且未配置议员时，用占位议员回显（便于无 agent 时验证链路，对应 OMO Council 手动触发范式）
    const effectiveCouncillors = councillorIds.length > 0
      ? councillorIds
      : (simulate ? ['councillor-a', 'councillor-b', 'councillor-c'] : []);
    const effectiveSynth = synthId || (simulate ? 'synthesizer' : '');

    if (effectiveCouncillors.length === 0) throw new Error('仲裁委员会：未配置议员智能体（councillorAgentIds）');
    if (!effectiveSynth) throw new Error('仲裁委员会：未配置合成智能体（synthesizerAgentId）');

    const disputeText = typeof dispute === 'string' ? dispute : JSON.stringify(dispute, null, 2);
    const basePrompt =
      `【仲裁背景】\n${context || '（无）'}\n\n` +
      `【争议观点】\n${disputeText}\n\n` +
      `【仲裁问题】\n${question}\n\n` +
      `请以「观点方 / 核心论据 / 倾向结论」三段式给出你的独立评估。`;

    // —— 并行层：各议员独立评估（对应 OMO councillors 并行扇形展开） ——
    const storeAgents = useWorkflowStore.getState().agents;
    const parallelTasks = effectiveCouncillors.map(async (agentId, i) => {
      const name = storeAgents.find((a) => a.id === agentId)?.name ?? agentId;
      if (simulate) {
        // 离线模拟：不调 LLM，占位回显（验证并行扇形结构）
        await new Promise((r) => setTimeout(r, 30));
        return {
          name,
          reply: `[离线模拟·议员${i + 1}] 针对争议给出独立评估意见（synthesizer 将综合此视角）。`,
          failed: false as boolean,
        };
      }
      try {
        const reply = await ctx.llm(agentId, [{ role: 'user', content: basePrompt }], undefined);
        return { name, reply, failed: false as boolean };
      } catch (e) {
        ctx.logger.error(`议员 ${name} 评估失败：${(e as Error).message}`);
        return { name, reply: '', failed: true as boolean };
      }
    });
    const councillors = await Promise.all(parallelTasks);
    const succeeded = councillors.filter((c) => !c.failed);
    const partialFailure = succeeded.length < councillors.length;

    if (succeeded.length === 0) {
      throw new Error('仲裁委员会：全部议员评估失败，无法合成裁决');
    }

    // —— 合成层：独立模型提炼单一裁决（对应 OMO synthesizer 与并行层分离） ——
    const synthPrompt =
      `你是仲裁主席。以下多位独立评估员对同一起争议给出了意见，请综合提炼为单一裁决。\n\n` +
      `【争议背景】\n${context || '（无）'}\n\n` +
      `【争议观点】\n${disputeText}\n\n` +
      `【各议员独立意见】\n` +
      succeeded.map((c, i) => `议员${i + 1}（${c.name}）：\n${c.reply}`).join('\n\n') +
      `\n\n请给出：①最终裁决 ②采纳了哪些意见/驳回了哪些 ③剩余不确定性。`;

    let verdict: string;
    if (simulate) {
      verdict =
        `[离线模拟·主席裁决] 综合 ${succeeded.length} 位议员意见，形成单一裁决（synthesizer=${effectiveSynth}）。\n` +
        `争议文件需按「保留双方非重叠改动 + 重叠区仲裁」原则合并。`;
    } else {
      verdict = await ctx.llm(effectiveSynth, [{ role: 'user', content: synthPrompt }], undefined);
    }

    // —— 共识评级（对应 OMO Consensus Rating） ——
    let consensus: CouncilVerdict['consensus'] = 'split';
    if (succeeded.length === councillors.length) {
      // 全部成功：粗判一致（真实分歧度可由主席 verdict 文本细化，此处给默认 unanimous）
      consensus = succeeded.length > 1 ? 'unanimous' : 'unanimous';
    } else {
      consensus = 'majority';
    }

    const result: CouncilVerdict = { verdict, councillors, consensus, partialFailure };
    ctx.logger.info(`仲裁完成：共识=${consensus}${partialFailure ? '（部分议员失败，已用成功者合成）' : ''}`);

    const decision = (consensus as CouncilVerdict['consensus']) === 'split' ? '需复议' : '采纳';
    const backflowPayload = buildBackflow({ consensus, decision, proposal: question });
    publishCouncilArtifact(params, result);

    // 声明下游可用分支（verdict 数据 + backflow 控制流端口，供回流上游重派）
    return {
      verdict: result,
      councillors: succeeded.map((c) => ({ name: c.name, reply: c.reply })),
      consensus,
      backflow: backflowPayload,
    };
  },
};

/** coord.council 回流裁决的形状（经 backflow 控制流端口回流上游重派）；参考 OMO 两层 + consensus 评级。 */
interface CouncilBackflow {
  consensus: CouncilVerdict['consensus'];
  decision: '采纳' | '需复议';
  proposal: string;
  rework: boolean; // true 表示建议上游重派（仅当 split/majority 且非采纳）
}

/** 依据共识评级构造回流裁决；对标 OMO「两层 + 共识评级」：unanimous/majority 视为可采纳，split 触发回流重派。 */
function buildBackflow(args: { consensus: CouncilVerdict['consensus']; decision: string; proposal: string }): CouncilBackflow {
  const rework = args.consensus === 'split' || args.decision === '需复议';
  return { consensus: args.consensus, decision: args.decision as '采纳' | '需复议', proposal: args.proposal, rework };
}

/** coord.council 执行完后，把裁决写入项目级黑板（跨工作流协作）。stage 由节点参数 pipelineStage 决定（默认 'design'）。 */
function publishCouncilArtifact(params: Record<string, unknown>, payload: CouncilVerdict): void {
  const stage = String(params.pipelineStage ?? '').trim();
  if (!stage) return;
  try {
    publishArtifactFromNode({ stage, kind: 'council', payload });
  } catch (e) {
    console.warn('[coord.council] 发布 council artifact 失败：', e);
  }
}

/**
 * 条件/循环断点（Loop Gate / Condition Break）：
 * 输出端口声明 `flow: 'control'`，作为 stage 边界——执行引擎在拓扑排序时
 * 把 control 边指向的下游强制推入更高 stage，从而「条件节点 → 循环体 → 回指条件节点」
 * 这类伪环不被误判成环，又能保证每一轮 gate 的顺序。
 *
 * 迭代循环（Step 6）：执行引擎识别到由 control 边构成的回环后，会重复跑整个 stage 序列。
 * 每一轮 gate 走 `pass` 分支 ⇒ 循环继续；走 `stop` 分支 ⇒ 循环体被剪枝、本轮结束即退出循环。
 * 每轮执行前会把当前轮次（从 0 开始）写入 `ctx.vars[loopVar]`，供循环体内部条件判断使用。
 */
export const nodeLoopGate: NodeDefinition = {
  typeId: 'flow.loopGate',
  name: '循环/条件断点',
  category: '流程',
  role: 'orchestrator',
  whenToUse: '构成循环或条件重试：循环体尾部以 control（紫色）边回指本节点，执行引擎会做多轮迭代。',
  description:
    '条件判断节点，其「通过」端口为控制流（control，紫色）语义。用于构成循环：循环体尾部以 control 边回指本节点。拓扑排序时 control 边视作 stage 断点，不破坏环检测。条件为假时下游被剪枝。执行引擎会对 control 回环做真正的多轮迭代（Step 6）。',
  inputs: [{ id: 'cond', label: '条件', type: 'any' }],
  outputs: [
    { id: 'pass', label: '通过', type: 'any', flow: 'control' },
    { id: 'stop', label: '终止', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '条件表达式（可选，留空则直接用输入端口「条件」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：i < 5，或 status == "running"（i 为循环变量）',
    },
    {
      key: 'maxLoops',
      label: '最大循环轮数（防止死循环）',
      type: 'number',
      default: 20,
    },
    {
      key: 'loopVar',
      label: '循环变量名（每轮写入 ctx.vars，供表达式引用）',
      type: 'text',
      default: 'i',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    // 每轮由执行引擎写入当前轮次到 ctx.vars[loopVar]
    const loopVar = String(params.loopVar ?? 'i');
    const loopIndex = (ctx.vars[loopVar] as number) ?? 0;
    let value: unknown;
    if (expr) {
      const result = evalExpr(expr, { ...ctx.vars, ...inputs });
      value = result;
    } else {
      value = inputs.cond;
    }
    const truthy = isTruthy(value);
    // 仅激活「通过」或仅「终止」分支；另一分支下游被剪枝
    ctx.setBranches?.(truthy ? ['pass'] : ['stop']);
    return {
      taken: truthy ? 'pass' : 'stop',
      // 告诉执行引擎当前循环轮次，用于多轮迭代调度
      __loopIndex: loopIndex,
    };
  },
};

/* ============================================================================
 * 验证 / 断言节点（verify.assert）
 * - 流程质量 gate：对上游值做断言（条件 / JSON Schema / 相等 / 非空）。
 * - 通过走 data 边（pass），失败走 control 边（fail，紫色），下游被剪枝 ⇒
 *   仅下游为 fail 分支时中止，不影响 pass 分支下游（gate 语义）。
 * - failFast 开启时直接抛错 ⇒ 该节点 error，下游按既有 failed 集合被跳过/传染。
 * ==========================================================================*/

/** 极简 JSON Schema 校验（仅支持 type/required/properties 的子集，够用且零依赖） */
function checkJsonSchema(value: unknown, schema: Record<string, any>): string[] {
  const errs: string[] = [];
  const type = schema.type;
  if (type) {
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value)))
      errs.push(`期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
    else if (type === 'array' && !Array.isArray(value))
      errs.push(`期望 array，实际 ${typeof value}`);
    else if (
      ['string', 'number', 'boolean'].includes(type) &&
      typeof value !== type
    )
      errs.push(`期望 ${type}，实际 ${typeof value}`);
  }
  if (schema.required && Array.isArray(value) === false && value && typeof value === 'object') {
    for (const k of schema.required as string[]) {
      if (!(k in (value as Record<string, any>)))
        errs.push(`缺少必填字段 "${k}"`);
    }
  }
  return errs;
}

export const nodeAssert: NodeDefinition = {
  typeId: 'verify.assert',
  name: '验证 / 断言',
  category: '流程',
  role: 'verifier',
  whenToUse: '作为流程质量闸门：在关键步骤后校验输出（真值/表达式/Schema/相等/非空），失败可剪枝下游或抛错中止。',
  description:
    '流程质量闸门。对上游输入 value 做断言：条件表达式为真、或匹配 JSON Schema、或等于期望值、或不为空。通过走 data 边「通过」，失败走 control 边「失败」（下游被剪枝）。开启「失败时中止」则直接抛错使下游按失败集合被跳过。',
  inputs: [{ id: 'value', label: '待验证值', type: 'any' }],
  outputs: [
    { id: 'pass', label: '通过', type: 'any' },
    { id: 'fail', label: '失败', type: 'any', flow: 'control' },
  ],
  params: [
    {
      key: 'mode',
      label: '断言模式',
      type: 'select',
      options: [
        { value: 'truthy', label: '真值（非空/非假）' },
        { value: 'expression', label: '表达式为真（用 value 与 ctx.vars）' },
        { value: 'equals', label: '等于期望值' },
        { value: 'schema', label: '匹配 JSON Schema' },
        { value: 'nonEmpty', label: '非空（字符串/数组/对象）' },
      ],
      default: 'truthy',
    },
    {
      key: 'expression',
      label: '表达式（mode=expression 时生效）',
      type: 'textarea',
      default: '',
      placeholder: '例如：value.length > 0 或 status == "ok"',
    },
    {
      key: 'expected',
      label: '期望值（mode=equals 时生效）',
      type: 'text',
      default: '',
    },
    {
      key: 'schema',
      label: 'JSON Schema（mode=schema 时生效）',
      type: 'textarea',
      default: '',
      placeholder: '{ "type": "object", "required": ["id"] }',
    },
    {
      key: 'failFast',
      label: '失败时中止（抛错，下游按失败集合跳过）',
      type: 'boolean',
      default: false,
    },
    {
      key: 'message',
      label: '断言说明（可选，用于失败日志）',
      type: 'text',
      default: '',
    },
  ],
  async execute(inputs, params, ctx) {
    const value = inputs.value;
    const mode = String(params.mode ?? 'truthy');
    const note = String(params.message ?? '');
    let ok = false;
    const reasons: string[] = [];

    switch (mode) {
      case 'truthy':
        ok = isTruthy(value);
        if (!ok) reasons.push('值为 falsy');
        break;
      case 'expression': {
        const expr = String(params.expression ?? '').trim();
        if (!expr) {
          ok = true; // 空表达式视为通过
        } else {
          const r = evalExpr(expr, { ...ctx.vars, value });
          ok = isTruthy(r);
          if (!ok) reasons.push(`表达式 "${expr}" 为假`);
        }
        break;
      }
      case 'equals': {
        const expected = params.expected;
        ok = JSON.stringify(value) === JSON.stringify(expected);
        if (!ok) reasons.push(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(value)}`);
        break;
      }
      case 'schema': {
        const raw = String(params.schema ?? '').trim();
        if (!raw) {
          ok = true;
        } else {
          let schema: Record<string, any>;
          try {
            schema = JSON.parse(raw);
          } catch (e) {
            reasons.push('Schema 不是合法 JSON');
            ok = false;
            break;
          }
          const errs = checkJsonSchema(value, schema);
          ok = errs.length === 0;
          if (!ok) reasons.push(...errs);
        }
        break;
      }
      case 'nonEmpty': {
        if (typeof value === 'string') ok = value.trim().length > 0;
        else if (Array.isArray(value)) ok = value.length > 0;
        else if (value && typeof value === 'object') ok = Object.keys(value).length > 0;
        else ok = false;
        if (!ok) reasons.push('值为空');
        break;
      }
      default:
        ok = true;
    }

    if (ok) {
      ctx.setBranches?.(['pass']);
      ctx.logger.info(note ? `断言通过：${note}` : '断言通过');
      return { pass: true, fail: false, ok: true };
    }

    // 失败
    const detail = `${note ? note + ' — ' : ''}${reasons.join('；') || '断言失败'}`;
    if (String(params.failFast ?? false) === 'true') {
      throw new Error(`[验证/断言] ${detail}`);
    }
    ctx.setBranches?.(['fail']);
    ctx.logger.error(`断言失败：${detail}`);
    return { pass: false, fail: true, ok: false, reason: detail };
  },
};

/* ============================================================================
 * Step 5：具体化 worker 节点（Scaffolder / Implementer / Validator）
 * - Scaffolder / Implementer 为「普通节点」：单次 ctx.llm 调用。
 * - Validator 为「自主节点」试点：节点内部跑 think→act→observe 小循环，
 *   评估不合格时带批评意见自我重试，封在节点内、对外仍是单一输入输出端口
 *   （对应 4.1 混合路线：画布管宏观、节点内部管微观自主）。
 * 三者共享：绑定智能体 + 角色 + 节点级模型覆写 + 离线模拟模式。
 * ==========================================================================*/

/** 取绑定 agentId / 角色系统提示词 / 模型覆写；模拟模式直接回显装配结果 */
async function resolveWorkerCtx(
  params: Record<string, unknown>,
  ctx: ExecContext,
  defaultSystem: string,
  kindLabel: string,
): Promise<{
  agentId: string;
  system: string;
  modelOverride: string;
  simulate: boolean;
}> {
  const agentId = String(params.agentId ?? '');
  const roleId = String(params.roleId ?? '');
  const roles = useWorkflowStore.getState().roles;
  const role = findRole(roles, roleId || undefined);
  const system = resolveRoleSystem(role, String(params.system ?? '')) || defaultSystem;
  const modelOverride = String(params.modelOverride ?? '').trim();
  const simulate = String(params.simulate ?? 'off') === 'on';
  if (!simulate && !agentId)
    throw new Error(`[${kindLabel}] 未绑定智能体，请在右侧面板选择（或开启离线模拟模式）`);
  ctx.logger.info(
    `${kindLabel}${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''}`,
  );
  return { agentId, system, modelOverride, simulate };
}

/** 模拟模式：回显装配结果（不调 LLM），供无模型时验证链路 */
async function simulateWorker(
  ctx: ExecContext,
  kindLabel: string,
  system: string,
  parts: string[],
): Promise<string> {
  const lines = [`【离线模拟 · ${kindLabel}】`, `— 系统提示词 —`, system || '（无）', '', ...parts];
  let acc = '';
  for (const seg of lines) {
    acc += (acc ? '\n' : '') + seg;
    ctx.setPartial('out', acc);
    await new Promise((r) => setTimeout(r, 20));
  }
  ctx.logger.info(`离线模拟完成 ${kindLabel}`);
  return acc;
}

const workerScaffolder: NodeDefinition = {
  typeId: 'worker.scaffolder',
  name: '架构师',
  category: 'worker',
  description:
    '根据上游规格（spec）生成实现计划：文件树骨架 + 分步任务说明。一次 LLM 调用产出结构化 plan。',
  inputs: [
    { id: 'spec', label: '规格', type: 'text' },
    { id: 'context', label: '上下文', type: 'text' },
  ],
  outputs: [{ id: 'plan', label: '实现计划', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const spec = String(inputs.spec ?? '');
    if (!spec) throw new Error('架构师缺少规格输入（spec 端口）');
    const context = inputs.context != null ? String(inputs.context) : '';
    const { system, simulate } = await resolveWorkerCtx(
      params,
      ctx,
      '你是资深软件架构师。依据给定规格输出实现计划：文件树骨架与分步任务，条理清晰、可交予实现工执行。',
      '架构师',
    );
    if (simulate) {
      return {
        plan: await simulateWorker(ctx, '架构师', system, [
          `— 规格 —`,
          spec,
          context ? `— 上下文 —\n${context}` : '',
          `— 模拟产出：实现计划 —`,
          '[模拟模式：关闭后此处为模型生成的文件树 + 分步任务]',
        ]),
      };
    }
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: `规格：\n${spec}${context ? `\n\n附加上下文：\n${context}` : ''}`,
    });
    const agentId = String(params.agentId ?? '');
    const modelOverride = String(params.modelOverride ?? '').trim();
    let acc = '';
    const plan = await ctx.llm(agentId, messages, (d) => {
      acc += d;
      ctx.setPartial('plan', acc);
    }, modelOverride || undefined);
    return { plan };
  },
};

const workerImplementer: NodeDefinition = {
  typeId: 'worker.implementer',
  name: '实现工',
  category: 'worker',
  description:
    '依据上游实现计划（plan）编写代码，输出 code。一次 LLM 调用产出。',
  inputs: [
    { id: 'plan', label: '实现计划', type: 'text' },
    { id: 'context', label: '上下文', type: 'text' },
  ],
  outputs: [{ id: 'code', label: '代码', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const plan = String(inputs.plan ?? '');
    if (!plan) throw new Error('实现工缺少实现计划输入（plan 端口）');
    const context = inputs.context != null ? String(inputs.context) : '';
    const { system, simulate } = await resolveWorkerCtx(
      params,
      ctx,
      '你是资深工程师。依据实现计划编写完整、可运行的代码，只输出代码与必要注释。',
      '实现工',
    );
    if (simulate) {
      return {
        code: await simulateWorker(ctx, '实现工', system, [
          `— 实现计划 —`,
          plan,
          context ? `— 上下文 —\n${context}` : '',
          `— 模拟产出：代码 —`,
          '[模拟模式：关闭后此处为模型生成的代码]',
        ]),
      };
    }
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: `实现计划：\n${plan}${context ? `\n\n附加上下文：\n${context}` : ''}`,
    });
    const agentId = String(params.agentId ?? '');
    const modelOverride = String(params.modelOverride ?? '').trim();
    let acc = '';
    const code = await ctx.llm(agentId, messages, (d) => {
      acc += d;
      ctx.setPartial('code', acc);
    }, modelOverride || undefined);
    return { code };
  },
};

const workerValidator: NodeDefinition = {
  typeId: 'worker.validator',
  name: '校验工（自主）',
  category: 'worker',
  description:
    '自主节点试点：对代码按标准自我评估，不合格时带批评意见返回重跑修订，最多 maxIter 轮。对外仍是单一输入/输出端口（混合路线：节点内部管微观自主）。',
  inputs: [
    { id: 'code', label: '代码', type: 'text' },
    { id: 'criteria', label: '验收标准', type: 'text' },
  ],
  outputs: [
    { id: 'verdict', label: '结论(pass/fail)', type: 'text' },
    { id: 'report', label: '评审报告', type: 'text' },
    { id: 'iterations', label: '迭代轮数', type: 'text' },
    { id: 'fail', label: '验收失败(控制流)', type: 'any', flow: 'control' },
  ],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    {
      key: 'mode',
      label: '验收模式',
      type: 'select',
      default: 'block',
      options: [
        { value: 'block', label: '单块评审（逐代码块 PASS/FAIL + 修订闭环）' },
        { value: 'project', label: '整项目验收（把输入当完整交付物做集成测试）' },
      ],
    },
    { key: 'maxIter', label: '最大迭代轮数', type: 'number', default: 3 },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const code = String(inputs.code ?? '');
    if (!code) throw new Error('校验工缺少代码输入（code 端口）');
    const criteria = inputs.criteria != null ? String(inputs.criteria) : '交付物应正确、可运行、符合要求。';
    const maxIter = Math.max(1, Number(params.maxIter ?? 3) || 1);
    const mode = String(params.mode ?? 'block');
    const { system, simulate, modelOverride } = await resolveWorkerCtx(
      params,
      ctx,
      '你是严格的代码评审。先给出 PASS/FAIL 判定，再给简洁的改进意见。若 FAIL，指出必须修正的点。',
      '校验工',
    );

    // —— 整项目验收模式（14.D）：把输入当完整交付物做集成测试，单轮判定，不回贴修订代码 ——
    if (mode === 'project') {
      if (simulate) {
        const ok = code.trim().length > 0;
        const sim = await simulateWorker(ctx, '校验工（整项目验收·模拟）', system, [
          `— 整项目交付物 —`,
          code.slice(0, 500),
          `— 验收标准 —`,
          criteria,
          `— 模拟产出：${ok ? '判定 PASS（输入非空）' : '判定 FAIL（输入为空）'} —`,
        ]);
        if (!ok) ctx.setBranches?.(['fail']);
        return { verdict: ok ? 'pass(sim)' : 'fail(sim)', report: sim, iterations: '1' };
      }
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({
        role: 'user',
        content:
          `【整项目验收 / 集成测试】你正在验收整个项目交付物，而不是单文件代码块。\n` +
          `验收标准：\n${criteria}\n\n` +
          `项目交付物（可能含多个模块/文件，已合并）：\n${code}\n\n` +
          `请检查模块间接口对接、依赖完整性、能否组装运行。先给 PASS/FAIL 判定，再给验收报告（列出通过项与遗留问题）。`,
      });
      let acc = '';
      const out = await ctx.llm(String(params.agentId ?? ''), messages, (d) => {
        acc += d;
        ctx.setPartial('report', acc);
      }, modelOverride || undefined);
      const verdict = /^\s*PASS\b/i.test(out) || /\bPASS\b/i.test(out.split('\n')[0] ?? '') ? 'pass' : 'fail';
      if (verdict === 'fail') ctx.setBranches?.(['fail']);
      return { verdict, report: out, iterations: '1' };
    }

    // —— 单块评审模式（默认，保持原有逐块 PASS/FAIL + 修订闭环）——
    if (simulate) {
      const sim = await simulateWorker(ctx, '校验工（自主·模拟）', system, [
        `— 代码 —`,
        code.slice(0, 500),
        `— 验收标准 —`,
        criteria,
        `— 模拟产出：判定 PASS（模拟不真正迭代） —`,
      ]);
      return { verdict: 'pass(sim)', report: sim, iterations: '1' };
    }

    const agentId = String(params.agentId ?? '');
    let current = code;
    let lastReport = '';
    let verdict = 'fail';
    for (let i = 1; i <= maxIter; i++) {
      ctx.logger.info(`校验工 第 ${i}/${maxIter} 轮评估`);
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({
        role: 'user',
        content:
          `验收标准：\n${criteria}\n\n当前代码（第 ${i} 轮）：\n${current}` +
          (i > 1 ? `\n\n上一轮评审意见：\n${lastReport}\n请重新评估；若仍 FAIL 请直接给出修订后的完整代码。` : ''),
      });
      let acc = '';
      const out = await ctx.llm(agentId, messages, (d) => {
        acc += d;
        ctx.setPartial('report', `第${i}轮:\n${acc}`);
      }, modelOverride || undefined);
      lastReport = out;
      current = extractRevisedCode(out, current);
      if (/^\s*PASS\b/i.test(out) || /\bPASS\b/i.test(out.split('\n')[0] ?? '')) {
        verdict = 'pass';
        break;
      }
      verdict = 'fail';
    }
    return { verdict, report: lastReport, iterations: String(maxIter) };
  },
};

/** 从评审输出中抽取「修订后的完整代码」：优先取 ```lang 代码块，否则回退原文 */
function extractRevisedCode(out: string, fallback: string): string {
  const m = out.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : fallback;
}

/* ===================== 步骤 14.F：Builder 生成施工/物业工作流 ===================== */

/**
 * `builder.generate`：读取 architect.design 的 `design` + `modules`，生成「施工方 / 物业」
 * 两张工作流 JSON（复用 builder.ts 模板），并按参数 `autoRegister` 注册进项目（方案 A：
 * 可见可改）。每个 worker 的 agent 绑定由 `module.category` 经项目级 `agentRouteTable` 路由。
 */
export const nodeBuilder: NodeDefinition = {
  typeId: 'builder.generate',
  name: '工作流生成器',
  category: '派发',
  description: '依据架构设计自动生成「施工方 + 物业」两张工作流，并注册进项目。',
  inputs: [
    { id: 'design', label: '设计书', type: 'text' },
    { id: 'modules', label: '模块清单', type: 'list' },
  ],
  outputs: [
    { id: 'constructionWf', label: '施工方工作流', type: 'json' },
    { id: 'opsWf', label: '物业运维工作流', type: 'json' },
  ],
  params: [
    {
      key: 'autoRegister',
      label: '自动注册进项目（标签页可见可改）',
      type: 'select',
      default: 'on',
      options: [
        { value: 'on', label: '开启（生成即注册）' },
        { value: 'off', label: '关闭（仅输出 JSON）' },
      ],
    },
    {
      key: 'constructionName',
      label: '施工方工作流名称',
      type: 'text',
      default: '施工方工作流',
    },
    {
      key: 'opsName',
      label: '物业运维工作流名称',
      type: 'text',
      default: '物业运维工作流',
    },
  ],
  async execute(inputs, params, ctx) {
    const modulesRaw = inputs.modules;
    const modules: ModuleItem[] = Array.isArray(modulesRaw)
      ? modulesRaw.filter((m): m is ModuleItem => !!m && typeof m === 'object')
      : [];
    if (modules.length === 0) {
      // design 可能是唯一输入：尝试从 design 文本无法结构化解析，要求 modules 端口接入
      throw new Error('builder.generate 缺少模块清单（modules 端口需接 architect.design 的 modules）');
    }

    const st = useWorkflowStore.getState();
    const routeTable = st.agentRouteTable ?? {};
    const fallbackAgentId = st.defaultAgentId || (st.agents[0]?.id ?? null);

    const constructionWf = buildConstructionWorkflow({
      modules,
      routeTable,
      fallbackAgentId,
      name: String(params.constructionName || '施工方工作流'),
    });
    const opsWf = buildOpsWorkflow({
      fallbackAgentId,
      name: String(params.opsName || '物业运维工作流'),
    });

    const autoRegister = String(params.autoRegister ?? 'on') === 'on';
    if (autoRegister) {
      try {
        const cId = st.registerWorkflow(constructionWf, { activate: false });
        const oId = st.registerWorkflow(opsWf, { activate: false });
        ctx.logger.info(`Builder 已注册工作流：施工=${cId} 物业=${oId}`);
        // 注册后落盘：项目已保存过（有 projectPath）则增量写盘到 .slimemold/workflows/<id>.json；
        // 否则只留在内存态，提示用户先保存项目（避免 Tauri 下弹出另存为打断自动化）
        if (st.projectPath) {
          try {
            await st.saveProject();
            ctx.logger.info(`Builder 已将生成的工作流落盘到 ${st.projectPath}/.slimemold/workflows/`);
          } catch (e) {
            ctx.logger.warn(`Builder 落盘失败（已保留在内存）：${(e as Error).message}`);
          }
        } else {
          ctx.logger.warn('当前项目尚未保存，生成的工作流仅驻留内存；请先保存项目以落盘到 .slimemold/workflows/');
        }
      } catch (e) {
        ctx.logger.error(`Builder 注册工作流失败：${(e as Error).message}`);
      }
    }

    return { constructionWf, opsWf };
  },
};

/* ===================== 步骤 14.B：跨工作流交付 / 接收 ===================== */

const HANDOFF_KINDS: { value: string; label: string }[] = [
  { value: 'plan', label: '计划书 plan' },
  { value: 'design', label: '设计书 design' },
  { value: 'project', label: '项目交付 project' },
  { value: 'bugreport', label: 'Bug 报告 bugreport' },
  { value: 'constructionWf', label: '施工工作流 constructionWf' },
  { value: 'opsWf', label: '运维工作流 opsWf' },
  { value: 'custom', label: '自定义（填 kind 文本）' },
];

/**
 * `pipeline.handoff`：把本工作流的产物交付到项目级黑板（跨工作流传递）。
 * 参数 `stage` 决定落到哪个阶段槽位；`kind` 决定产物类型。下游工作流经
 * `pipeline.receive` 同 stage+kind 读回。本质复用 pipeline.publishArtifact。
 */
export const nodeHandoff: NodeDefinition = {
  typeId: 'pipeline.handoff',
  name: '交付（跨工作流）',
  category: '派发',
  description: '把产物写入项目级黑板指定阶段，供其他工作流接收。',
  inputs: [{ id: 'payload', label: '交付物', type: 'any' }],
  outputs: [{ id: 'artifact', label: '交付回执', type: 'json' }],
  params: [
    { key: 'stage', label: '目标阶段（黑板槽位）', type: 'text', default: 'construction', placeholder: '如 plan/design/construction/ops' },
    {
      key: 'kind',
      label: '交付物类型',
      type: 'select',
      default: 'project',
      options: HANDOFF_KINDS,
    },
    { key: 'kindCustom', label: '自定义 kind（kind=自定义时生效）', type: 'text', default: '' },
    { key: 'meta', label: '附带元信息（任意文本，如模块 scope 汇总）', type: 'text', default: '', placeholder: '可选，随交付物透传给下游' },
  ],
  async execute(inputs, params, ctx) {
    const stage = String(params.stage ?? '').trim();
    if (!stage) throw new Error('pipeline.handoff 缺少目标阶段（stage 参数）');
    const kindSel = String(params.kind ?? 'project');
    const kind: ArtifactKind = kindSel === 'custom' ? String(params.kindCustom ?? '').trim() || 'custom' : kindSel;
    const payload = inputs.payload;
    if (payload === undefined) throw new Error('pipeline.handoff 缺少交付物（payload 端口）');
    // meta 可选：对象型 payload 时附加 _meta 字段，便于下游 receive 拿到 scope 等上下文（步骤 14 跨工作流透传）
    const meta = String(params.meta ?? '').trim();
    const finalPayload =
      meta && payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), _meta: meta }
        : payload;
    const artifact = publishArtifactFromNode({ stage, kind, payload: finalPayload });
    ctx.logger.info(`交付完成 stage=${stage} kind=${kind} version=${artifact.version}`);
    return { artifact };
  },
};

/**
 * `pipeline.receive`：从项目级黑板读取上游工作流交付的产物（同 stage+kind）。
 * 黑板为内存态，读取同步；上游须先 handoff。读不到时按 `onError` 决定报错或返回空。
 */
export const nodeReceive: NodeDefinition = {
  typeId: 'pipeline.receive',
  name: '接收（跨工作流）',
  category: '派发',
  description: '从项目级黑板读取指定阶段的产物。',
  inputs: [],
  outputs: [
    { id: 'payload', label: '交付物', type: 'any' },
    { id: 'artifact', label: '回执', type: 'json' },
  ],
  params: [
    { key: 'stage', label: '来源阶段（黑板槽位）', type: 'text', default: 'construction', placeholder: '如 plan/design/construction/ops' },
    {
      key: 'kind',
      label: '交付物类型',
      type: 'select',
      default: 'project',
      options: HANDOFF_KINDS,
    },
    { key: 'kindCustom', label: '自定义 kind（kind=自定义时生效）', type: 'text', default: '' },
    {
      key: 'onError',
      label: '读不到时',
      type: 'select',
      default: 'error',
      options: [
        { value: 'error', label: '报错（阻断）' },
        { value: 'empty', label: '返回空 payload' },
      ],
    },
  ],
  async execute(_inputs, params, ctx) {
    const stage = String(params.stage ?? '').trim();
    if (!stage) throw new Error('pipeline.receive 缺少来源阶段（stage 参数）');
    const kindSel = String(params.kind ?? 'project');
    const kind: ArtifactKind = kindSel === 'custom' ? String(params.kindCustom ?? '').trim() || 'custom' : kindSel;
    const artifact = getArtifact(stage, kind);
    if (!artifact) {
      if (String(params.onError ?? 'error') === 'empty') {
        return { payload: null, artifact: null };
      }
      throw new Error(`pipeline.receive 读不到交付物（stage=${stage} kind=${kind}）`);
    }
    ctx.logger.info(`接收完成 stage=${stage} kind=${kind} version=${artifact.version}`);
    return { payload: artifact.payload, artifact };
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
  nodeWriteFile,
  preview,
  textOutput,
  nodeAuditor,
  nodePlan,
  nodeArchitect,
  nodeDispatch,
  nodeResolver,
  nodeCouncil,
  nodeLoopGate,
  nodeAssert,
  workerScaffolder,
  workerImplementer,
  workerValidator,
  nodeBuilder,
  nodeHandoff,
  nodeReceive,
  ...creativeNodes,
].map(createNodeDef);

export function registerBuiltins(): void {
  useRegistryStore.getState().register(builtinDefs);
  // 内置工具（writeFile/http）下沉为 ToolRegistry 一等公民，供 AgentHarness 按名调用
  // 必须在 builtinDefs 就绪后注册（builtinTools 复用节点 execute）
  toolRegistry.register(builtinTools);
}
